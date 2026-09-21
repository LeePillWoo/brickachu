import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, guiParams } from '../js/state.js';
import { animals, grabbedAnimal, clearAllAnimals } from '../js/entities.js';
import { foods, spawnFood, clearAllFood } from '../js/food.js';
import { placeVoxel, pushHistory, applyActionState, undo, redo } from '../js/scene.js';
import { onPointerDown, onPointerUp, onPointerMove, onPointerCancel, onKeyDown, onKeyUp, onWindowResize } from '../js/input.js';

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
function reset() {
    onPointerCancel();
    clearAllAnimals();
    clearAllFood();
    applyActionState(JSON.stringify({ settings: guiParams, blocks: [] }));
    state.currentMode = 'add';
    state.snackIngredients = [];
    state.animalMode = 'spawn';
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
console.log(`${passed} input regression cases passed`);
