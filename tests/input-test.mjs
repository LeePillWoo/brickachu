import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, guiParams } from '../js/state.js';
import { animals, grabbedAnimal, clearAllAnimals, GROUP_ANIMALS, spawnDog, triggerClickAction } from '../js/entities.js';
import { foods, spawnFood, clearAllFood } from '../js/food.js';
import { placeVoxel, pushHistory, applyActionState, undo, redo } from '../js/scene.js';
import { onPointerDown, onPointerUp, onPointerMove, onPointerCancel, onKeyDown, onKeyUp, onWindowResize } from '../js/input.js';
import { spawnTrain, clearTrain, beginTrainRoute, appendTrainRoutePoint, finishTrainRoute } from '../js/train.js';
import { updateAnimalPowers } from '../js/animal-powers.js';

state.scene = new THREE.Scene();
state.world = new CANNON.World();
state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000));
state.plane.geometry.rotateX(-Math.PI / 2);
state.scene.add(state.plane);
objects.push(state.plane);
state.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
state.camera.position.set(0, 1000, 1);
state.camera.lookAt(0, 0, 0);
state.camera.updateMatrixWorld();
state.rollOverMesh = new THREE.Mesh(state.cubeGeo);
state.rollOverMaterial = new THREE.MeshBasicMaterial();
state.controls = { enabled: true };
state.renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) }, setSize() {} };
materials['preset-0'] = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
const canvas = { closest: () => null };
const input = { closest: () => ({}) };
let elementAtPointer = canvas;
document.elementFromPoint = () => elementAtPointer;
const event = (x = 25, z = 25, extra = {}) => {
    const point = new THREE.Vector3(x, 0, z).project(state.camera);
    return { pointerId: 1, button: 0, buttons: 0, pointerType: 'mouse', isPrimary: true, target: canvas,
        clientX: (point.x + 1) * 500, clientY: (1 - point.y) * 500, ...extra };
};
const click = e => { onPointerDown(e); onPointerUp(e); };
const count = () => objects.length - 1;
function fixtureAnimal(x = 25, z = 25) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40));
    mesh.position.set(x, 25, z);
    const animal = { mesh, body: new CANNON.Body({ mass: 1 }), heightOffset: 8, grabbed: false };
    mesh.userData.animalRef = animal;
    animal.body.position.set(x, 45, z);
    animals.push(animal); state.scene.add(mesh);
    return animal;
}

function outsideAnimal(animal, pixels, pointerType) {
    state.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(animal.mesh);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        corners.push(new THREE.Vector3(x, y, z).project(state.camera));
    }
    const center = bounds.getCenter(new THREE.Vector3()).project(state.camera);
    return event(25, 25, { pointerType, clientX: (Math.max(...corners.map(p => p.x)) + 1) * 500 + pixels, clientY: (1 - center.y) * 500 });
}
function reset() {
    onPointerCancel();
    clearTrain();
    clearAllAnimals();
    clearAllFood();
    applyActionState(JSON.stringify({ settings: guiParams, blocks: [] }));
    state.currentMode = 'add';
    state.snackIngredients = [];
    state.animalMode = 'spawn';
    state.controls.enabled = true;
    state.actionHistory.length = 0;
    state.actionRedoStack.length = 0;
    pushHistory();
    elementAtPointer = canvas;
}
let passed = 0;
function check(name, fn) { reset(); fn(); passed++; console.log(`PASS ${name}`); }
check('one mouse click builds exactly one block and one history step', () => {
    click(event()); assert.equal(count(), 1); assert.equal(state.actionHistory.length, 2);
    undo(); assert.equal(count(), 0);
});
check('right, middle, Alt and orphan pointer releases cannot build', () => {
    click(event(25, 25, { button: 2 })); click(event(25, 25, { button: 1 }));
    click(event(25, 25, { altKey: true })); onPointerUp(event()); assert.equal(count(), 0);
});
check('GUI and popup gestures cannot build; captured release above UI cancels preview', () => {
    click(event(25, 25, { target: input })); assert.equal(count(), 0);
    onPointerDown(event()); elementAtPointer = input; onPointerUp(event()); assert.equal(count(), 0);
});
check('animal removal mode cannot create or remove blocks', () => {
    state.animalMode = 'remove'; click(event()); assert.equal(count(), 0);
    placeVoxel(new THREE.Vector3(25, 25, 25)); state.currentMode = 'remove';
    click(event()); assert.equal(count(), 1);
});
check('Escape and pointercancel discard build gestures', () => {
    onPointerDown(event()); onKeyDown({ code: 'Escape', key: 'Escape', target: canvas }); onPointerUp(event()); assert.equal(count(), 0);
    onPointerDown(event()); onPointerCancel({ type: 'pointercancel', pointerId: 1 }); onPointerUp(event()); assert.equal(count(), 0);
});
check('second touch cancels editing and a swipe returning to its origin is not a tap', () => {
    const touch = event(25, 25, { pointerType: 'touch' });
    onPointerDown(touch); onPointerDown({ ...touch, pointerId: 2, isPrimary: false }); onPointerUp(touch); assert.equal(count(), 0);
    onPointerDown(touch); onPointerMove({ ...touch, clientX: touch.clientX + 30 }); onPointerMove(touch); onPointerUp(touch); assert.equal(count(), 0);
    click(touch); assert.equal(count(), 1);
});
check('removal drag includes first block and undo restores its entire gesture', () => {
    placeVoxel(new THREE.Vector3(25, 25, 25)); placeVoxel(new THREE.Vector3(125, 25, 25));
    state.currentMode = 'remove'; const before = state.actionHistory.length;
    onPointerDown(event()); onPointerMove(event(125)); onPointerUp(event(125));
    assert.equal(count(), 0); assert.equal(state.actionHistory.length, before + 1);
    undo(); assert.equal(count(), 2);
});
check('healthy food with consumeTimer -1 remains selectable for removal', () => {
    spawnFood(new THREE.Vector3(25, 0, 25)); assert.equal(foods.length, 1);
    state.animalMode = 'remove'; click(event()); assert.equal(foods.length, 0);
});
check('editable fields ignore shortcuts, physical keys work in Korean layout, blur resets motion', () => {
    onKeyDown({ key: 'w', code: 'KeyW', target: input }); assert.equal(state.keys.w, false);
    onKeyDown({ key: 'ㅈ', code: 'KeyW', target: canvas }); assert.equal(state.keys.w, true);
    onPointerDown(event()); assert.equal(state.keys.w, true);
    onPointerCancel({ type: 'blur' }); assert.equal(state.keys.w, false);
    onKeyDown({ key: 'ㅈ', code: 'KeyW', target: canvas }); onKeyUp({ key: 'ㅈ', code: 'KeyW' }); assert.equal(state.keys.w, false);
});
check('resize updates postprocessing render target size', () => {
    window.innerWidth = 1200; window.innerHeight = 700;
    let size; state.composer = { setSize: (...v) => { size = v; } };
    onWindowResize(); assert.deepEqual(size, [1200, 700]);
    state.camera.aspect = 1; state.camera.updateProjectionMatrix();
});
check('cancelled animal hold does not activate later; removed animals are not revived on release', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40)); mesh.position.set(25, 25, 25);
    const a = { mesh, body: new CANNON.Body({ mass: 1 }), heightOffset: 8, grabbed: false };
    mesh.userData.animalRef = a; a.body.position.set(25, 45, 25); animals.push(a); state.scene.add(mesh);
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const timers = new Map(); let next = 0;
    globalThis.setTimeout = fn => { timers.set(++next, fn); return next; };
    globalThis.clearTimeout = id => timers.delete(id);
    try {
        onPointerDown(event()); assert.equal(timers.size, 1);
        onPointerCancel({ type: 'pointercancel', pointerId: 1 }); assert.equal(timers.size, 0); assert.equal(a.grabbed, false);
        onPointerDown(event()); [...timers.values()][0](); timers.clear(); assert.equal(a.grabbed, true); assert.equal(state.controls.enabled, false);
        animals.length = 0; state.scene.remove(mesh); onPointerUp(event());
        assert.equal(a.grabbed, false); assert.equal(grabbedAnimal, null); assert.equal(state.controls.enabled, true);
    } finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
});
check('hand tool grabs immediately for mouse and touch, moves once, and releases without editing', () => {
    for (const pointerType of ['mouse', 'touch']) {
        const animal = fixtureAnimal();
        state.currentMode = 'grab';
        const start = event(25, 25, { pointerType });
        onPointerDown(start);
        assert.equal(grabbedAnimal, animal, 'no long-press timer is needed');
        assert.equal(animal.grabbed, true);
        assert.equal(state.controls.enabled, false);
        assert.ok(animal.mesh.position.y >= 120);
        onPointerMove(event(225, 125, { pointerType }));
        onPointerUp(event(225, 125, { pointerType }));
        assert.equal(grabbedAnimal, null);
        assert.equal(animal.grabbed, false);
        assert.equal(state.controls.enabled, true);
        assert.ok(Math.abs(animal.mesh.position.x - 225) < 1e-6);
        assert.ok(Math.abs(animal.mesh.position.z - 125) < 1e-6);
        assert.ok(Math.abs(animal.mesh.position.y) < 1e-6);
        assert.equal(count(), 0); assert.equal(foods.length, 0);
        clearAllAnimals();
    }
});
check('hand tool accepts near-silhouette touches but not remote empty space', () => {
    for (const [pointerType, margin] of [['mouse', 6], ['touch', 12]]) {
        const animal = fixtureAnimal();
        state.currentMode = 'grab';
        const near = outsideAnimal(animal, margin, pointerType);
        onPointerDown(near);
        assert.equal(grabbedAnimal, animal, `${pointerType} has a forgiving CSS-pixel target`);
        onPointerCancel();
        const far = outsideAnimal(animal, 40, pointerType);
        click(far);
        assert.equal(grabbedAnimal, null);
        assert.equal(count(), 0);
        clearAllAnimals();
    }
});
check('hand selection never passes through a block or locomotive and never modifies either', () => {
    fixtureAnimal(); state.currentMode = 'grab';
    placeVoxel(new THREE.Vector3(25, 75, 25));
    onPointerDown(event(25, 25, { pointerType: 'touch' }));
    assert.equal(grabbedAnimal, null);
    onPointerUp(event());
    assert.equal(count(), 1);
    reset(); fixtureAnimal(); state.currentMode = 'grab';
    const train = spawnTrain(new THREE.Vector3(25, 0, 25));
    onPointerDown(event()); onPointerMove(event(225)); onPointerUp(event(225));
    assert.equal(grabbedAnimal, null);
    assert.equal(train.drawing, false);
    assert.equal(state.controls.enabled, true);
    assert.equal(state.train, train);
});
check('hand tool cancellation, second touch, removal and tool changes restore controls', () => {
    const cancellations = [
        () => onPointerCancel({ type: 'pointercancel', pointerId: 1 }),
        () => onKeyDown({ code: 'Escape', key: 'Escape', target: canvas }),
        () => onPointerCancel({ type: 'blur' }),
        () => onPointerDown(event(225, 125, { pointerId: 2, isPrimary: false, pointerType: 'touch' })),
        () => { onPointerCancel(); state.currentMode = 'eyes'; },
        () => { clearAllAnimals(); onPointerMove(event(225, 125)); }
    ];
    for (const cancel of cancellations) {
        const animal = fixtureAnimal(); state.currentMode = 'grab';
        onPointerDown(event(25, 25, { pointerType: 'touch' }));
        assert.equal(animal.grabbed, true);
        cancel(); onPointerUp(event());
        assert.equal(animal.grabbed, false); assert.equal(grabbedAnimal, null);
        assert.equal(state.controls.enabled, true);
        clearAllAnimals();
    }
    fixtureAnimal(); state.currentMode = 'grab'; state.controls.enabled = false;
    onPointerDown(event()); onPointerCancel();
    assert.equal(state.controls.enabled, false, 'an already disabled camera stays disabled');
});
check('grabbing a passenger immediately detaches its train connection', () => {
    const train = spawnTrain(new THREE.Vector3(-300, 0, 25));
    const animal = fixtureAnimal();
    train.followers.push(animal);
    animal.trainRide = { train };
    state.currentMode = 'grab';
    onPointerDown(event());
    assert.equal(animal.grabbed, true);
    assert.equal(animal.trainRide, undefined);
    assert.equal(train.followers.length, 0);
    assert.equal(train.ropes.length, 0);
    onPointerUp(event());
    assert.ok(animal.trainJoinCooldown > 0);
});
check('picking up a rolling panda or sliding otter resets its pose before lifting', () => {
    for (const type of ['panda', 'otter']) {
        GROUP_ANIMALS.grabTest = [type];
        const animal = spawnDog('grabTest'); delete GROUP_ANIMALS.grabTest;
        animal.body.position.set(25, animal.heightOffset * 2.5, 25);
        animal.mesh.position.set(25, 0, 25); animal.mesh.rotation.set(0, 0, 0);
        triggerClickAction(animal); updateAnimalPowers(animals, 0.2);
        assert.ok(animal.animalPower?.controlsMotion);
        assert.ok(Math.abs(animal.mesh.rotation.x) > 0.1);
        state.scene.updateMatrixWorld(true);
        const point = new THREE.Box3().setFromObject(animal.mesh).getCenter(new THREE.Vector3()).project(state.camera);
        const down = event(25, 25, { clientX: (point.x + 1) * 500, clientY: (1 - point.y) * 500 });
        state.currentMode = 'grab'; onPointerDown(down);
        assert.equal(grabbedAnimal, animal);
        assert.equal(animal.animalPower, undefined);
        assert.ok(Math.abs(animal.mesh.rotation.x) < 1e-6);
        assert.equal(animal.mesh.position.x, 25); assert.equal(animal.mesh.position.z, 25);
        onPointerUp(down);
        assert.ok(Math.abs(animal.mesh.position.y) < 1e-6);
        clearAllAnimals();
    }
});
check('eyes hover and click animate only the connected build with undo and redo', () => {
    placeVoxel(new THREE.Vector3(25, 25, 25));
    placeVoxel(new THREE.Vector3(25, 75, 25));
    placeVoxel(new THREE.Vector3(225, 25, 25));
    state.currentMode = 'eyes';
    onPointerMove(event());
    assert.equal(state.eyesPreview.visible, true);
    assert.equal(state.eyesPreview.children.length, 2);
    click(event());
    assert.equal(count(), 1);
    assert.equal(animals.length, 1);
    assert.ok(animals[0].livingId);
    assert.equal(state.eyesPreview.visible, false);
    const friend = animals[0];
    click(event());
    assert.ok(friend.clickActionTimer > 0, 'a second eyes-mode tap makes the friend react');
    assert.equal(animals.length, 1);
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    let hold;
    globalThis.setTimeout = fn => { hold = fn; return 1; };
    globalThis.clearTimeout = () => { hold = null; };
    try {
        onPointerDown(event());
        assert.equal(typeof hold, 'function');
        hold();
        assert.equal(friend.grabbed, true);
        assert.equal(state.controls.enabled, false);
        onPointerUp(event());
        assert.equal(friend.grabbed, false);
        assert.equal(state.controls.enabled, true);
    } finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
    undo(); assert.equal(count(), 3); assert.equal(animals.length, 0);
    redo(); assert.equal(count(), 1); assert.equal(animals.length, 1);
});
check('eyes cancel and UI gestures leave block creations untouched', () => {
    placeVoxel(new THREE.Vector3(25, 25, 25));
    state.currentMode = 'eyes';
    onPointerDown(event()); onPointerCancel(); onPointerUp(event());
    click(event(25, 25, { target: input }));
    click(event(225, 25));
    assert.equal(count(), 1); assert.equal(animals.length, 0);
});
check('snack mode directly feeds a block friend and ordinary apple restores it', () => {
    placeVoxel(new THREE.Vector3(25, 25, 25));
    state.currentMode = 'eyes'; click(event());
    const animal = animals[0];
    state.currentMode = 'food'; state.snackIngredients = ['balloon', 'jelly'];
    click(event());
    assert.deepEqual(animal.magicEffect.ingredients, ['balloon', 'jelly']);
    assert.equal(animal.grabbed, false); assert.equal(foods.length, 0);
    state.snackIngredients = []; click(event());
    assert.ok(!animal.magicEffect);
    assert.equal(count(), 0);
});
check('placed magic snacks keep a copy of the chosen recipe', () => {
    state.currentMode = 'food'; state.snackIngredients = ['rainbow'];
    click(event());
    assert.equal(foods.length, 1);
    state.snackIngredients.push('jelly');
    assert.deepEqual(foods[0].ingredients, ['rainbow']);
    assert.equal(count(), 0);
});

check('train mode places one train only on the floor and a new floor tap replaces it', () => {
    state.currentMode = 'train';
    click(event(25, 25, { target: input }));
    click(event(25, 25, { button: 2 }));
    assert.equal(state.train, null);
    placeVoxel(new THREE.Vector3(225, 25, 25));
    onPointerMove(event(225));
    assert.equal(state.targetGuideOpacity, 0, 'train hover never becomes a remove-block guide');
    click(event(225));
    assert.equal(state.train, null, 'a block surface is not a train platform');
    assert.equal(count(), 1);
    click(event());
    const first = state.train;
    assert.ok(first);
    assert.ok(first.position.distanceTo(new THREE.Vector3(25, 0, 25)) < 1e-8);
    click(event(425));
    assert.ok(state.train);
    assert.notEqual(state.train, first);
    assert.equal(first.mesh.parent, null);
    assert.ok(state.train.position.distanceTo(new THREE.Vector3(425, 0, 25)) < 1e-8);
    assert.equal(count(), 1);
    assert.equal(foods.length, 0);
});

check('clicking a train in any editing mode never edits blocks, feeds it, or changes its route', () => {
    const train = spawnTrain(new THREE.Vector3(25, 0, 25));
    assert.ok(train);
    const routeBefore = train.route.map(point => point.toArray());
    for (const mode of ['add', 'remove', 'eyes', 'food', 'train']) {
        state.currentMode = mode;
        onPointerMove(event());
        assert.equal(state.targetGuideOpacity, 0);
        assert.ok(!state.eyesPreview?.visible);
        onPointerDown(event());
        assert.equal(state.controls.enabled, false, `${mode}: camera is locked before touch OrbitControls receives the down event`);
        assert.equal(state.isDraggingBuild, false);
        assert.equal(state.isDraggingRemove, false);
        onPointerUp(event());
        assert.equal(state.controls.enabled, true);
        assert.deepEqual(train.route.map(point => point.toArray()), routeBefore);
        assert.equal(train.drawing, false);
        assert.equal(state.train, train);
    }
    assert.equal(count(), 0);
    assert.equal(foods.length, 0);
    assert.equal(animals.length, 0);
});

check('mouse and touch train drags seed the current position, project to floor, and never teleport', () => {
    for (const pointerType of ['mouse', 'touch']) for (const mode of ['add', 'remove', 'eyes', 'food', 'train']) {
        clearTrain();
        const train = spawnTrain(new THREE.Vector3(25, 0, 25));
        state.currentMode = mode;
        const original = train.position.clone();
        const start = event(25, 25, { pointerType });
        onPointerDown(start);
        assert.equal(state.controls.enabled, false);
        onPointerMove({ ...start, clientX: start.clientX + 2 });
        assert.equal(train.drawing, false, 'minor click jitter does not begin a route');
        onPointerMove(event(225, 125, { pointerType }));
        assert.equal(train.drawing, true);
        assert.ok(train.route[0].distanceTo(original) < 1e-8, 'the seed is not the raised locomotive surface');
        assert.ok(train.position.distanceTo(original) < 1e-8);
        onPointerUp(event(325, 175, { pointerType }));
        assert.equal(train.drawing, false);
        assert.ok(train.route.length >= 2);
        assert.ok(train.route.every(point => point.y === 0));
        assert.ok(train.route.at(-1).distanceTo(new THREE.Vector3(325, 0, 175)) < 1e-8);
        assert.ok(train.position.distanceTo(original) < 1e-8, 'movement is left to the train simulation');
        assert.equal(state.controls.enabled, true);
        assert.equal(count(), 0);
        assert.equal(foods.length, 0);
    }
});

function seedTrainRoute(train) {
    assert.equal(beginTrainRoute(train), true);
    appendTrainRoutePoint(new THREE.Vector3(25, 0, 225));
    assert.equal(finishTrainRoute(), true);
    return train.route.map(point => point.toArray());
}

check('captured pointer moves over UI add no route samples and UI release restores the old route', () => {
    const train = spawnTrain(new THREE.Vector3(25, 0, 25));
    const previous = seedTrainRoute(train);
    const touch = event(25, 25, { pointerType: 'touch' });
    onPointerDown(touch);
    onPointerMove(event(225, 125, { pointerType: 'touch' }));
    const drawn = train.route.map(point => point.toArray());
    elementAtPointer = input;
    onPointerMove(event(425, 175, { pointerType: 'touch' }));
    assert.deepEqual(train.route.map(point => point.toArray()), drawn);
    onPointerUp(event(425, 175, { pointerType: 'touch' }));
    assert.deepEqual(train.route.map(point => point.toArray()), previous);
    assert.equal(train.drawing, false);
    assert.equal(state.controls.enabled, true);
});

check('Escape, pointercancel, blur, and a second touch cancel a train route and unlock the camera', () => {
    const cancellations = [
        () => onKeyDown({ code: 'Escape', key: 'Escape', target: canvas }),
        () => onPointerCancel({ type: 'pointercancel', pointerId: 1 }),
        () => onPointerCancel({ type: 'blur' }),
        () => onPointerDown(event(400, 100, { pointerType: 'touch', pointerId: 2, isPrimary: false, target: input }))
    ];
    for (const cancel of cancellations) {
        clearTrain();
        const train = spawnTrain(new THREE.Vector3(25, 0, 25));
        const previous = seedTrainRoute(train);
        const touch = event(25, 25, { pointerType: 'touch' });
        onPointerDown(touch);
        onPointerMove(event(225, 125, { pointerType: 'touch' }));
        cancel();
        onPointerUp(touch);
        assert.deepEqual(train.route.map(point => point.toArray()), previous);
        assert.equal(train.drawing, false);
        assert.equal(state.controls.enabled, true);
    }
});

check('train deletion during a drag cannot revive it or leave the camera locked', () => {
    spawnTrain(new THREE.Vector3(25, 0, 25));
    onPointerDown(event()); onPointerMove(event(225));
    assert.equal(state.controls.enabled, false);
    clearTrain();
    onPointerMove(event(325)); onPointerUp(event(325));
    assert.equal(state.train, null);
    assert.equal(state.controls.enabled, true);
    assert.equal(count(), 0);
});

check('train gestures restore an already disabled camera and removal mode only deletes the train', () => {
    spawnTrain(new THREE.Vector3(25, 0, 25));
    state.controls.enabled = false;
    onPointerDown(event()); onPointerMove(event(225)); onPointerCancel();
    assert.equal(state.controls.enabled, false);
    state.controls.enabled = true;
    state.animalMode = 'remove';
    onPointerDown(event());
    assert.equal(state.controls.enabled, true, 'removal never enters route drawing');
    onPointerUp(event());
    assert.equal(state.train, null);
    assert.equal(count(), 0);
});
console.log(`${passed} input regression cases passed`);
