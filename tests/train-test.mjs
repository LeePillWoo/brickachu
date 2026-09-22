import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, explodingBricks } from '../js/state.js';
import { animals, GROUP_ANIMALS, MAX_ANIMALS, spawnDog, clearAllAnimals, updateDogs, setGrabbedAnimal, removeAnimalImmediately, triggerClickAction } from '../js/entities.js';
import { placeVoxel, explodeBricks, disposeExplodingBrick, pushHistory, undo, redo } from '../js/scene.js';
import { awakenBlocks } from '../js/living.js';
import { clearAllFood, spawnFood, foods } from '../js/food.js';
import { applySnack, updateMagicEffects } from '../js/magic.js';
import { spawnTrain, clearTrain, beginTrainRoute, appendTrainRoutePoint, finishTrainRoute, cancelTrainRoute, updateTrain, syncTrainRopes, MAX_TRAIN_ROUTE_POINTS, MAX_TRAIN_ROUTE_LENGTH } from '../js/train.js';

const point = (x, z, y = 0) => new THREE.Vector3(x, y, z);
let testAudioContext = null;
function reset() {
    clearTrain(); clearAllAnimals(); clearAllFood();
    while (explodingBricks.length) disposeExplodingBrick(explodingBricks.pop());
    objects.length = 0;
    state.scene = new THREE.Scene(); state.previewScene = null; state.previewObjects.length = 0;
    state.world = new CANNON.World({ gravity: new CANNON.Vec3(0,-1470,0) });
    state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000,2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    state.scene.add(state.plane); objects.push(state.plane);
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() }); ground.quaternion.setFromEuler(-Math.PI / 2,0,0); state.world.addBody(ground);
    materials['preset-0'] = new THREE.MeshPhysicalMaterial({ color: 0xffdd77 }); state.currentSlot = 'preset-0';
    state.actionHistory.length = 0; state.actionRedoStack.length = 0;
    state.screenShakeTimer = 0; state.onToyNotice = null;
    state.camera = null; state.renderer = null;
    state.controls = null;
    document.hidden = false;
}
function pet(type, x, z) {
    GROUP_ANIMALS.trainTest = [type]; const animal = spawnDog('trainTest'); delete GROUP_ANIMALS.trainTest;
    animal.body.position.set(x, animal.heightOffset * 2.5, z); animal.mesh.position.set(x,0,z);
    animal.body.velocity.set(0,0,0); animal.mesh.rotation.set(0,0,0);
    animal.state = 'idle'; animal.timer = 1000; animal.speed = 200;
    return animal;
}
function route(...points) {
    assert.equal(beginTrainRoute(), true);
    points.forEach(position => assert.equal(appendTrainRoutePoint(position), true));
    assert.equal(finishTrainRoute(), true);
}
function step(count = 1) {
    for (let index = 0; index < count; index++) {
        if (testAudioContext) testAudioContext.currentTime += 1 / 60;
        state.world.step(1 / 60); updateTrain(1 / 60); updateDogs(1 / 60); updateMagicEffects(animals, 1 / 60); syncTrainRopes();
    }
}
function contact(train, animal) {
    animal.body.position.set(train.position.x, animal.heightOffset * 2.5, train.position.z);
    animal.mesh.position.set(train.position.x, 0, train.position.z);
    animal.body.velocity.set(0,0,0); animal.mesh.updateMatrixWorld(true);
    updateTrain(1 / 60);
    assert.equal(animal.trainRide?.train, train, `${animal.animalType}: real engine contact must reserve a tail place`);
}
function settle(train) {
    for (let i = 0; i < 1200 && train.followers.some(animal => animal.trainRide.joining); i++) step();
    assert.ok(train.followers.every(animal => !animal.trainRide.joining), 'every contacted friend must settle at the tail');
}
function captureAudio() {
    const previous = window.AudioContext, oscillators = [];
    class Param {
        value = 1;
        setValueAtTime(value) { this.start ??= value; this.value = value; }
        linearRampToValueAtTime() {}
        exponentialRampToValueAtTime() {}
    }
    class Node {
        gain = new Param(); frequency = new Param(); Q = new Param();
        connect() {} disconnect() {} start() {} stop() { this.onended?.(); }
    }
    window.AudioContext = class {
        state = 'running'; currentTime = 10; sampleRate = 8000; destination = {};
        constructor() { testAudioContext = this; }
        createGain() { return new Node(); }
        createOscillator() { const node = new Node(); oscillators.push(node); return node; }
        createBufferSource() { return new Node(); }
        createBiquadFilter() { return new Node(); }
        createBuffer(channels, length) { return { getChannelData() { return new Float32Array(length); } }; }
    };
    return {
        oscillators,
        beats: () => oscillators.map(node => node.frequency.start).filter(freq => freq === 170 || freq === 116),
        pings: () => oscillators.filter(node => node.frequency.start === 1174).length,
        close() { if (testAudioContext) testAudioContext.state = 'closed'; testAudioContext = null; window.AudioContext = previous; }
    };
}
let passed = 0;
function test(name, fn) { reset(); fn(); passed++; console.log(`PASS ${name}`); }

test('one locomotive spawns on empty ground with interactive wheels and replaces its predecessor cleanly', () => {
    const first = spawnTrain(point(0,0));
    assert.equal(first.mesh.userData.trainRef, first); assert.equal(first.wheels.length, 6);
    let disposals = 0; const geometry = first.mesh.children.find(child => child.geometry).geometry;
    geometry.addEventListener('dispose', () => disposals++);
    const next = spawnTrain(point(200,0));
    assert.equal(state.train, next); assert.equal(first.mesh.parent, null); assert.equal(disposals, 1);
    assert.equal(state.scene.children.filter(child => child.name === 'friend-train').length, 1);
});

test('invalid or occupied placement does not destroy the existing train', () => {
    const train = spawnTrain(point(-300,0));
    placeVoxel(point(25,25,25));
    assert.equal(spawnTrain(point(25,25)), null);
    assert.equal(spawnTrain(point(400,0,50)), null);
    assert.equal(spawnTrain(point(NaN,0)), null);
    assert.equal(state.train, train);
});

test('automatic train placement finds nearby empty ground without overlapping blocks, friends or snacks', () => {
    state.controls = { target: point(25,25) };
    const block = placeVoxel(point(25,25,25));
    const animal = pet('dog', -100,0), food = spawnFood(point(100,0));
    const train = spawnTrain();
    assert.ok(train);
    assert.ok(Math.abs(train.position.x) <= 832 && Math.abs(train.position.z) <= 832);
    assert.ok(Math.abs(train.position.x - block.position.x) >= 93 || Math.abs(train.position.z - block.position.z) >= 93);
    const bounds = new THREE.Box3().setFromObject(animal.mesh);
    assert.ok(train.position.x + 68 <= bounds.min.x || train.position.x - 68 >= bounds.max.x || train.position.z + 68 <= bounds.min.z || train.position.z - 68 >= bounds.max.z);
    assert.ok(Math.hypot(train.position.x - food.position.x, train.position.z - food.position.z) >= 93);
    assert.ok(objects.includes(block)); assert.ok(foods.includes(food)); assert.ok(animals.includes(animal));
});

test('automatic placement failure leaves the previous train and its route intact', () => {
    const train = spawnTrain(point(0,0)); route(point(0,400));
    const previousRoute = train.route.map(p => p.toArray());
    for (let x = -800; x <= 800; x += 100) for (let z = -800; z <= 800; z += 100) placeVoxel(point(x,z,25),null,true);
    let notice; state.onToyNotice = value => { notice = value; };
    assert.equal(spawnTrain(), null); assert.equal(state.train, train);
    assert.deepEqual(train.route.map(p => p.toArray()), previousRoute);
    assert.match(notice, /빈자리/);
});

test('automatic placement finds a small empty pocket between block-aligned walls', () => {
    // The only clear ground is x,z in [-50,150]; its valid train centers are
    // [18,82], which a 100-unit grid centered on the origin misses completely.
    for (let x = -825; x <= 825; x += 50) for (let z = -825; z <= 825; z += 50) {
        if (x > -50 && x < 150 && z > -50 && z < 150) continue;
        placeVoxel(point(x,z,25),null,true);
    }
    const train = spawnTrain();
    assert.ok(train);
    for (const axis of ['x','z']) assert.ok(train.position[axis] >= 18 && train.position[axis] <= 82);
});

test('automatic placement keeps the front and back corners outside an overlapping UI panel', () => {
    state.camera = new THREE.PerspectiveCamera(45,1,1,5000);
    state.camera.position.set(0,800,1300); state.camera.lookAt(0,0,0); state.camera.updateMatrixWorld(true);
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) };
    state.renderer = { domElement: canvas };
    const panelTop = (1 - point(0,34).project(state.camera).y) * 500;
    const originalHitTest = document.elementFromPoint;
    document.elementFromPoint = (x,y) => y >= panelTop ? { panel: true } : canvas;
    try {
        const train = spawnTrain(); assert.ok(train);
        assert.ok(train.position.z < 0, 'the center is clear but the original front would overlap the panel');
        for (const x of [-68,68]) for (const z of [-68,68]) for (const y of [0,110]) {
            const corner = train.position.clone().add(new THREE.Vector3(x,y,z)).project(state.camera);
            assert.equal(document.elementFromPoint((corner.x+1)*500,(1-corner.y)*500),canvas);
        }
    } finally {
        if (originalHitTest) document.elementFromPoint = originalHitTest;
        else delete document.elementFromPoint;
    }
});

test('summons at capacity replace the oldest non-passenger and preserve joining friends, ropes and route', () => {
    assert.equal(MAX_ANIMALS,30);
    const first = pet('dog',0,-80); first.speed = 0;
    const train = spawnTrain(point(0,0)); route(point(0,600)); contact(train,first);
    const oldestFree = pet('cat',550,-650);
    const second = pet('dog',0,-180); second.speed = 0;
    contact(train,second);
    assert.equal(train.followers.length,2);
    while (animals.length < MAX_ANIMALS) pet('dog',550,-650);
    assert.equal(animals.find(animal => !animal.trainRide),oldestFree);
    const followers = [...train.followers], ropes = [...train.ropes], previousRoute = train.route.map(p => p.toArray());
    assert.ok(followers.every(animal => animal.trainRide.joining));
    for (let i = 0; i < 4; i++) {
        const previous = [...animals], victim = animals.find(animal => !animal.trainRide);
        const newcomer = spawnDog('all'); assert.ok(newcomer);
        assert.deepEqual(animals,[...previous.filter(animal => animal !== victim),newcomer]);
        assert.equal(animals.length,MAX_ANIMALS); assert.equal(victim.mesh.parent,null);
        assert.equal(state.train,train); assert.deepEqual(train.followers,followers); assert.deepEqual(train.ropes,ropes);
        assert.deepEqual(train.route.map(p => p.toArray()),previousRoute);
        assert.ok(followers.every(animal => animal.trainRide?.train === train));
    }
});

test('a full train of thirty genuinely recruited passengers rejects repeated summons without changing its queue', () => {
    for (let i = 0; i < MAX_ANIMALS; i++) pet('dog',550,-650).speed = 0;
    const train = spawnTrain(point(0,0)); route(point(0,600));
    animals.forEach(animal => contact(train,animal));
    assert.equal(train.followers.length,MAX_ANIMALS); assert.equal(train.ropes.length,MAX_ANIMALS);
    assert.ok(animals.every(animal => animal.trainRide?.train === train && animal.trainRide.joining));
    const friends = [...animals], followers = [...train.followers], ropes = [...train.ropes], previousRoute = train.route.map(p => p.toArray());
    let notice = ''; state.onToyNotice = value => { notice = value; };
    for (let i = 0; i < 4; i++) assert.equal(spawnDog('all'),null);
    assert.deepEqual(animals,friends); assert.equal(state.train,train);
    assert.deepEqual(train.followers,followers); assert.deepEqual(train.ropes,ropes);
    assert.deepEqual(train.route.map(p => p.toArray()),previousRoute);
    assert.match(notice,/기차/); assert.match(notice,/30/);
});

test('nearby animals do not board until their model actually touches the engine', () => {
    const far = pet('dog', -210,0), near = pet('cat',57,0), middle = pet('rabbit',-140,0);
    const train = spawnTrain(point(0,0)); route(point(0,700));
    updateTrain(1 / 60); assert.equal(train.followers.length,0);
    contact(train,near); assert.deepEqual(train.followers,[near]);
    assert.equal(far.trainRide,undefined); assert.equal(middle.trainRide,undefined);
    assert.ok(near.trainRide.joining); assert.equal(train.ropes[0].mesh.visible,false);
});

test('touching a moving tail does not recruit an animal that has not touched the engine', () => {
    const first = pet('dog',0,-70); const train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,first); settle(train);
    const late = pet('cat',first.body.position.x - 120,first.body.position.z);
    step(50); assert.deepEqual(train.followers,[first]); assert.equal(late.trainRide,undefined);
});

test('swept engine contact catches a fast crossing but ignores airborne and excluded friends', () => {
    const crossing = pet('cat',-120,0), above = pet('dog',0,0), floating = pet('rabbit',0,0);
    above.mesh.position.y = 250; above.body.position.y += 250;
    applySnack(floating,['balloon']);
    const train = spawnTrain(point(0,0)); route(point(0,700));
    crossing.body.position.x = 120; // Physics moved across the engine before the render mesh sync.
    updateTrain(1 / 60);
    assert.deepEqual(train.followers,[crossing]); assert.equal(above.trainRide,undefined); assert.equal(floating.trainRide,undefined);
});

test('a zero-speed join attempt cannot hold the locomotive forever', () => {
    const stuck = pet('dog',0,0); stuck.speed = 0;
    const train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,stuck);
    step(260); assert.ok(train.position.z > 300); assert.equal(stuck.trainRide,undefined);
});

test('route drawing pauses a contacted friend without expiring its side-step reservation', () => {
    const animal = pet('dog',0,0), train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,animal);
    const waiting = animal.trainRide.lastPosition.clone(); beginTrainRoute(); step(360);
    assert.equal(animal.trainRide?.train,train); assert.ok(animal.trainRide.lastPosition.equals(waiting));
    assert.equal(train.ropes[0].mesh.visible,false);
    cancelTrainRoute(); settle(train); assert.equal(train.ropes[0].mesh.visible,true);
});

test('contact at a board corner stays unjoined when neither side has safe space', () => {
    const animal = pet('dog',790,790), train = spawnTrain(point(790,790)); route(point(820,820));
    updateTrain(1 / 60);
    assert.equal(animal.trainRide,undefined); assert.equal(train.followers.length,0);
    assert.ok(train.position.x > 790 && train.position.z > 790);
});

test('a later engine contact waits beside the queue and only exposes its rope after the last friend', () => {
    const first = pet('dog',0,0), train = spawnTrain(point(0,-500)); route(point(0,700)); contact(train,first); settle(train);
    const second = pet('cat',600,-600); contact(train,second);
    let waited = false, connected = false;
    for (let frame = 0; frame < 800 && !connected; frame++) {
        step();
        const ride = second.trainRide; assert.ok(ride);
        if (ride.joining) {
            assert.equal(train.ropes[1].mesh.visible,false);
            if (!ride.approach && !ride.onTrail) waited = true;
            if (!ride.approach) {
                const a = new THREE.Box3().setFromObject(first.mesh), b = new THREE.Box3().setFromObject(second.mesh);
                assert.ok(!a.intersectsBox(b), 'newcomer cannot cross the previous passenger');
            }
        } else connected = true;
    }
    assert.ok(waited && connected); assert.deepEqual(train.followers,[first,second]);
    assert.equal(train.ropes[1].mesh.visible,true); assert.equal(train.ropes[1].from,first);
});

test('followers traverse the actual train corner instead of a diagonal shortcut', () => {
    const animal = pet('dog',0,-90); const train = spawnTrain(point(0,0)); route(point(0,400),point(400,400),point(400,0)); contact(train,animal);
    let samples = 0, afterCorner = false;
    for (let index = 0; index < 460; index++) {
        step();
        if (animal.trainRide && !animal.trainRide.joining) {
            const p = animal.body.position;
            assert.ok(Math.abs(p.x) < 1e-6 || Math.abs(p.z - 400) < 1e-6, `shortcut ${p.x},${p.z}`);
            if (p.x > 40 && Math.abs(p.z - 400) < 1e-6) afterCorner = true;
            samples++;
        }
    }
    assert.ok(samples > 100 && afterCorner);
    assert.ok(train.trail.some(sample => sample.position.distanceTo(point(0,400)) < 1e-6));
});

test('living block friends stay outside the train even when they are closest', () => {
    const normal = pet('dog',-160,0);
    const seed = placeVoxel(point(25,-200,25),null,true);
    placeVoxel(point(75,-200,25),null,true); placeVoxel(point(125,-200,25),null,true);
    const { animal: large } = awakenBlocks(seed);
    large.body.position.set(-40,25,0); large.mesh.position.set(-40,0,0);
    large.state = 'idle'; large.timer = 1000;
    const train = spawnTrain(point(0,0)); route(point(0,650)); contact(train,normal); step(90);
    assert.deepEqual(train.followers,[normal]);
    assert.equal(large.trainRide,undefined); assert.ok(animals.includes(large));
    assert.equal(train.ropes.length,1); assert.equal(train.ropes[0].to,normal);
});

test('drawing pauses motion and cancel restores the previous route and index exactly', () => {
    const train = spawnTrain(point(0,0)); route(point(0,400),point(300,400)); step(30);
    const oldRoute = train.route.map(p => p.toArray()), oldIndex = train.routeIndex, original = train.position.clone();
    assert.equal(beginTrainRoute(),true); assert.equal(appendTrainRoutePoint(point(-200,100)),true);
    step(100); assert.ok(train.position.equals(original));
    assert.equal(cancelTrainRoute(),true); assert.deepEqual(train.route.map(p => p.toArray()),oldRoute); assert.equal(train.routeIndex,oldIndex);
    step(20); assert.ok(train.position.distanceTo(original) > 10);
});

test('an empty gesture cancels safely, and completed routes return to automatic movement', () => {
    const train = spawnTrain(point(0,0));
    beginTrainRoute(); assert.equal(finishTrainRoute(),false); assert.equal(train.drawing,false);
    route(point(0,80)); step(50);
    assert.equal(train.route.length,0);
    const atEnd = train.position.clone(); step(40); assert.ok(train.position.distanceTo(atEnd) > 20);
});

test('routes cross walls without destroying while drawing and movement stays on the board', () => {
    const train = spawnTrain(point(0,0));
    const wall = placeVoxel(point(0,200,25),null,true);
    beginTrainRoute(); assert.equal(appendTrainRoutePoint(point(0,500)),true);
    assert.equal(train.route.length,2); step(120);
    assert.ok(objects.includes(wall)); assert.equal(explodingBricks.length,0); assert.equal(train.position.z,0);
    assert.equal(finishTrainRoute(),true); step(300);
    assert.ok(!objects.includes(wall)); assert.ok(train.position.z >= 500);
    for (let index = 0; index < 900; index++) {
        step(); assert.ok(Math.abs(train.position.x) <= 832 && Math.abs(train.position.z) <= 832);
    }
});

test('only blocks touched by actual travel break, releasing physics, preview and supported food', () => {
    state.previewScene = new THREE.Scene();
    const train = spawnTrain(point(0,0)); route(point(0,600));
    const wall = placeVoxel(point(0,200,25));
    const side = placeVoxel(point(200,200,25)), overhead = placeVoxel(point(0,200,175));
    const food = spawnFood(point(0,200,50),['rainbow']);
    const body = wall.userData.physicsBody, preview = wall.userData.previewMesh;
    let disposed = 0; preview.material.addEventListener('dispose',() => disposed++);
    step(58); assert.ok(objects.includes(wall)); assert.equal(explodingBricks.length,0);
    step(); assert.ok(!objects.includes(wall)); assert.ok(train.position.z < 110);
    assert.ok(objects.includes(side)); assert.ok(objects.includes(overhead));
    assert.equal(wall.parent,null); assert.equal(wall.userData.physicsBody,null); assert.ok(!state.world.bodies.includes(body));
    assert.equal(preview.parent,null); assert.equal(disposed,1); assert.ok(!state.previewObjects.includes(preview));
    assert.equal(explodingBricks.length,8); assert.equal(food.falling,true); assert.ok(foods.includes(food));
    const before = train.position.z; step(60); assert.ok(train.position.z > before + 100);
});

test('train destruction shares block undo and redo without duplicate bodies or fragments', () => {
    const train = spawnTrain(point(0,0));
    const position = point(0,200,25); placeVoxel(position); pushHistory();
    route(point(0,600)); step(59); assert.equal(objects.length,1); assert.equal(explodingBricks.length,8);
    undo(); assert.equal(objects.length,2); assert.ok(objects[1].position.equals(position));
    assert.equal(state.world.bodies.length,2); assert.equal(explodingBricks.length,0);
    redo(); assert.equal(objects.length,1); assert.equal(state.world.bodies.length,1);
    assert.equal(explodingBricks.length,0); assert.equal(state.train,train);
});

test('automatic driving breaks new blocks ahead instead of turning away from them', () => {
    const train = spawnTrain(point(0,0));
    train.autoGoal = point(0,600);
    const wall = placeVoxel(point(0,200,25),null,true);
    step(120); assert.ok(!objects.includes(wall)); assert.ok(train.position.z > 210); assert.equal(train.position.x,0);
});

test('blocks added beside a moving tail are cleared only when the follower reaches them', () => {
    const animal = pet('dog',0,-80), train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,animal); settle(train);
    assert.ok(animal.trainRide && !animal.trainRide.joining);
    const z = animal.body.position.z;
    const block = placeVoxel(point(0,z + 30,25),null,true);
    assert.ok(train.position.z - block.position.z > 100);
    updateTrain(1 / 60);
    assert.ok(!objects.includes(block)); assert.ok(animal.body.position.z > z);
    assert.equal(explodingBricks.length,8);
});

test('reversing travel smashes the intersecting wall without damaging distant blocks', () => {
    const train = spawnTrain(point(0,300));
    const wall = placeVoxel(point(0,100,25),null,true), remote = placeVoxel(point(250,100,25),null,true);
    route(point(0,-500)); step(120);
    assert.ok(!objects.includes(wall)); assert.ok(objects.includes(remote)); assert.ok(train.position.z < 90);
});

test('route samples, length and magical lights have bounded lifetimes', () => {
    const train = spawnTrain(point(0,0)); beginTrainRoute();
    for (let i = 1; i < 1000; i++) appendTrainRoutePoint(point((i % 2) * 25,Math.floor(i / 2) % 2 ? 25 : 0));
    assert.ok(train.route.length <= MAX_TRAIN_ROUTE_POINTS); assert.ok(train.draftLength <= MAX_TRAIN_ROUTE_LENGTH);
    assert.equal(finishTrainRoute(),true); assert.ok(train.pathVisual);
    step(205); assert.equal(train.pathVisual,null);
});

test('train friends never hunt or flee, including a predator waiting to join', () => {
    const predator = pet('lion',-50,0), prey = pet('rabbit',-170,0);
    const train = spawnTrain(point(0,0)); route(point(0,700));
    updateTrain(1 / 60); assert.equal(train.followers[0],predator); assert.ok(predator.trainRide.joining);
    updateDogs(1 / 60); assert.equal(prey.state,'idle'); assert.equal(prey.body.velocity.x,0);
    contact(train,prey); assert.ok(prey.trainRide); assert.equal(predator.trainRide.train,prey.trainRide.train);
    triggerClickAction(predator); assert.equal(predator.clickActionTimer,0);
});

test('even unjoined animals remain friends while a train exists, and normal fear returns after removal', () => {
    const predator = pet('lion',500,0), prey = pet('rabbit',650,0);
    spawnTrain(point(-500,0)); updateDogs(1 / 60);
    assert.equal(predator.trainRide,undefined); assert.equal(prey.trainRide,undefined);
    assert.equal(prey.state,'idle'); assert.equal(prey.body.velocity.x,0);
    clearTrain(); updateDogs(1 / 60);
    assert.equal(prey.state,'walking'); assert.ok(prey.body.velocity.x > 0);
});

test('a contacted friend steps aside and attaches at the tail without showing a long rope', () => {
    const animal = pet('dog',0,200); animal.speed = 400;
    const train = spawnTrain(point(0,0)); route(point(0,700));
    let contactSeen = false, asideSeen = false, attached = false;
    for (let i = 0; i < 420; i++) {
        step();
        if (!animal.trainRide) { assert.equal(train.ropes.length,0); continue; }
        contactSeen = true;
        if (animal.trainRide.joining) assert.equal(train.ropes[0].mesh.visible,false);
        if (animal.trainRide.approach?.length === 1) asideSeen = true;
        if (!animal.trainRide.joining) {
            attached = true; assert.equal(train.ropes[0].mesh.visible,true);
            assert.ok(train.ropes[0].start.distanceTo(train.ropes[0].end) < 220);
        }
    }
    assert.ok(contactSeen && asideSeen && attached);
});

test('large passengers join through narrow walls and their full model width is cleared', () => {
    const large = pet('elephant',0,-150);
    const train = spawnTrain(point(0,0)); route(point(0,650)); contact(train,large);
    const side = placeVoxel(point(130,250,25),null,true), remote = placeVoxel(point(250,250,25),null,true);
    settle(train); assert.ok(!objects.includes(side)); assert.ok(objects.includes(remote));
    assert.ok(train.position.z > 200); assert.ok(large.trainRide);
});

test('tall passengers clear overhead blocks at their actual height while higher blocks survive', () => {
    const tall = pet('giraffe',0,-170);
    const train = spawnTrain(point(0,0)); route(point(0,650)); contact(train,tall);
    const ceiling = placeVoxel(point(0,250,225),null,true), high = placeVoxel(point(0,250,425),null,true);
    settle(train); assert.ok(!objects.includes(ceiling)); assert.ok(objects.includes(high));
    assert.ok(train.position.z > 200); assert.ok(tall.trainRide);
});

test('balloon friends cannot board even when nearest, while other snack friends can', () => {
    const balloon = pet('dog',-50,0), normal = pet('cat',-150,0);
    applySnack(balloon,['balloon','jelly']); applySnack(normal,['rainbow']);
    const train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,normal); step(90);
    assert.deepEqual(train.followers,[normal]); assert.equal(balloon.trainRide,undefined);
    assert.equal(train.ropes.length,1); assert.ok(balloon.mesh.getObjectByName('snack-balloon-shell'));
    assert.equal(train.speed,110);
});

test('eating balloon detaches immediately, reconnects ropes and permits boarding after the effect is cleared', () => {
    const first = pet('dog',-60,0), second = pet('cat',-180,0);
    const train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,first); contact(train,second);
    assert.deepEqual(train.followers,[first,second]);
    applySnack(first,['balloon']);
    assert.equal(first.trainRide,undefined); assert.deepEqual(train.followers,[second]);
    assert.equal(train.ropes.length,1); assert.equal(train.ropes[0].from,train); assert.equal(train.ropes[0].to,second);
    step(130); assert.equal(first.trainRide,undefined);
    applySnack(first,[]);
    contact(train,first);
    assert.ok(first.trainRide); assert.equal(train.ropes.length,2);
});

test('updateTrain prunes externally applied balloon state before moving even during drawing', () => {
    const animal = pet('dog',-60,0), train = spawnTrain(point(0,0)); step();
    assert.ok(animal.trainRide); beginTrainRoute();
    animal.magicEffect = { ingredients: ['balloon'] }; updateTrain(1 / 60);
    assert.equal(animal.trainRide,undefined); assert.equal(train.ropes.length,0);
    delete animal.magicEffect;
});

test('grabbing, deleting and clearing release follower references and owned train resources', () => {
    const first = pet('dog',-60,0), second = pet('cat',-130,0); const train = spawnTrain(point(0,0)); route(point(0,600)); contact(train,first); contact(train,second);
    first.grabbed = true; setGrabbedAnimal(first); assert.equal(first.trainRide,undefined); assert.ok(!train.followers.includes(first));
    removeAnimalImmediately(second); assert.equal(second.trainRide,undefined); assert.equal(train.followers.length,0);
    const geometry = train.mesh.children.find(child => child.geometry).geometry; let disposed = 0; geometry.addEventListener('dispose',() => disposed++);
    beginTrainRoute(); appendTrainRoutePoint(point(-200,300));
    clearTrain(); clearTrain(); assert.equal(disposed,1); assert.equal(state.train,null); assert.equal(train.mesh.parent,null); assert.equal(train.pathVisual,null);
    assert.equal(cancelTrainRoute(),false); assert.equal(animals.length,1);
});

test('bomb cleanup cannot leave animals attached to a stale train', () => {
    const animal = pet('dog',-60,0); const train = spawnTrain(point(0,0)); step(); assert.ok(animal.trainRide);
    explodeBricks(); assert.equal(state.train,null); assert.equal(animal.trainRide,undefined); assert.equal(train.followers.length,0);
});

test('an existing member marked as a living block is detached and its rope is removed', () => {
    const animal = pet('dog',-60,0), train = spawnTrain(point(0,0)); step();
    assert.equal(train.ropes.length,1);
    animal.animalType = 'living-block'; updateTrain(1 / 60);
    assert.equal(animal.trainRide,undefined); assert.equal(train.followers.length,0); assert.equal(train.ropes.length,0);
    step(60); assert.equal(animal.trainRide,undefined);
});

test('ropes connect consecutive members with shared triangle geometry and natural sag', () => {
    const first = pet('dog',-70,0), second = pet('cat',-160,0);
    const train = spawnTrain(point(0,0)); route(point(0,600)); contact(train,first); contact(train,second); settle(train);
    assert.equal(train.ropeGroup.parent,state.scene); assert.equal(train.ropes.length,2);
    assert.equal(train.ropes[0].from,train); assert.equal(train.ropes[0].to,first);
    assert.equal(train.ropes[1].from,first); assert.equal(train.ropes[1].to,second);
    for (const rope of train.ropes) {
        assert.equal(rope.mesh.parent,train.ropeGroup); assert.equal(rope.segments.length,8);
        assert.ok(rope.segments.every(segment => segment.isMesh && !segment.isLine && segment.geometry === train.ropeGeometry && segment.material === train.ropeMaterial && segment.geometry.getAttribute('normal')));
        assert.ok(rope.segments[3].position.y < (rope.start.y + rope.end.y) / 2);
    }
    const before = train.ropes[0].end.clone(); step(30); assert.ok(train.ropes[0].end.distanceTo(before) > 10);
});

test('thin linen ropes keep a two CSS pixel minimum when the mobile camera zooms far away', () => {
    const animal = pet('dog',-70,0);
    const train = spawnTrain(point(0,0)); route(point(0,600)); contact(train,animal); settle(train);
    state.renderer = { domElement: { clientHeight: 844 } };
    state.camera = new THREE.PerspectiveCamera(45,390 / 844,1,100000);
    const start = train.ropes[0].start.clone(), end = train.ropes[0].end.clone();
    const geometry = train.ropeGeometry, material = train.ropeMaterial;
    assert.equal(geometry.parameters.radiusTop,3); assert.equal(material.color.getHex(),0x9c8f7d);
    assert.equal(material.emissive.getHex(),0);
    for (const distanceScale of [1,1.7,8]) {
        state.camera.position.set(500,800,1300).multiplyScalar(distanceScale);
        state.camera.lookAt(0,0,0); syncTrainRopes();
        for (const segment of train.ropes[0].segments) {
            const depth = -segment.position.clone().applyMatrix4(state.camera.matrixWorldInverse).z;
            const projectedWidth = geometry.parameters.radiusTop * segment.scale.x * state.camera.projectionMatrix.elements[5] * 844 / depth;
            assert.ok(projectedWidth >= 2 - 1e-6, `thin rope at zoom ${distanceScale}: ${projectedWidth}px`);
            if (distanceScale === 8) assert.ok(projectedWidth <= 2 + 1e-6, `oversized rope at zoom ${distanceScale}: ${projectedWidth}px`);
            assert.ok(segment.scale.x >= 1); assert.equal(segment.scale.x,segment.scale.z);
            assert.equal(segment.geometry,geometry); assert.equal(segment.material,material);
        }
        assert.ok(train.ropes[0].start.equals(start)); assert.ok(train.ropes[0].end.equals(end));
    }
});

test('rope endpoints follow final pudding turns and hopping animation in the same frame', () => {
    const first = pet('dog',0,-80), second = pet('rabbit',0,-190);
    const train = spawnTrain(point(0,0)); route(point(0,300),point(300,300),point(300,-300)); applySnack(first,['jelly']);
    contact(train,first); contact(train,second); settle(train);
    let checked = 0;
    for (let frame = 0; frame < 460; frame++) {
        step();
        for (const rope of train.ropes) {
            const animal = rope.to, halfHeight = animal.heightOffset * 2.5;
            const expected = new THREE.Vector3(0,Math.max(12,Math.min(halfHeight * 0.9,38)),28).applyMatrix4(animal.mesh.matrixWorld);
            assert.ok(rope.end.distanceTo(expected) < 1e-6, `stale rope at frame ${frame}`); checked++;
        }
    }
    assert.ok(checked > 600);
});

test('removing a middle friend reconnects ropes and final cleanup disposes shared resources once', () => {
    const first = pet('dog',-60,0), middle = pet('cat',-140,0), last = pet('rabbit',-230,0);
    const train = spawnTrain(point(0,0)); route(point(0,700)); contact(train,first); contact(train,middle); contact(train,last);
    const geometry = train.ropeGeometry, material = train.ropeMaterial; let geometryDisposals = 0, materialDisposals = 0;
    geometry.addEventListener('dispose',() => geometryDisposals++); material.addEventListener('dispose',() => materialDisposals++);
    removeAnimalImmediately(middle);
    assert.equal(train.ropes.length,2); assert.equal(train.ropes[1].from,first); assert.equal(train.ropes[1].to,last);
    assert.equal(geometryDisposals,0); assert.equal(materialDisposals,0);
    first.grabbed = true; setGrabbedAnimal(first);
    assert.equal(train.ropes.length,1); assert.equal(train.ropes[0].from,train); assert.equal(train.ropes[0].to,last);
    clearTrain(); clearTrain(); assert.equal(train.ropeGroup.parent,null); assert.equal(train.ropes.length,0);
    assert.equal(geometryDisposals,1); assert.equal(materialDisposals,1);
});

test('driving audio follows four wheel beats and pauses during drawing, hiding and standstill', () => {
    const audio = captureAudio();
    try {
        const train = spawnTrain(point(0,0)); route(point(0,700)); step(120);
        assert.deepEqual(audio.beats().slice(0,8),[170,170,116,116,170,170,116,116]);
        const beatCount = audio.beats().length, runningTime = train.runningTime, pingTimer = train.pingTimer;
        beginTrainRoute(); step(100);
        assert.equal(audio.beats().length,beatCount); assert.equal(train.runningTime,runningTime); assert.equal(train.pingTimer,pingTimer);
        assert.ok(train.steam.every(puff => puff.life === 0));
        document.hidden = true; cancelTrainRoute(); step(120);
        assert.equal(audio.beats().length,beatCount); assert.equal(train.runningTime,runningTime); assert.equal(train.pingTimer,pingTimer);
        assert.ok(train.steam.every(puff => puff.life === 0)); document.hidden = false;
        clearTrain(); const tired = pet('dog',-550,0); const stoppedTrain = spawnTrain(point(-500,0));
        route(point(-500,700)); contact(stoppedTrain,tired); settle(stoppedTrain); tired.speed = 0;
        const untouched = placeVoxel(point(stoppedTrain.position.x,stoppedTrain.position.z + 100,25),null,true);
        step(80); const stoppedBeats = audio.beats().length, stoppedTime = state.train.runningTime;
        step(120); assert.equal(audio.beats().length,stoppedBeats); assert.equal(state.train.runningTime,stoppedTime);
        assert.ok(state.train.steam.every(puff => puff.life === 0));
        assert.ok(objects.includes(untouched));
    } finally { document.hidden = false; audio.close(); }
});

test('a five-to-nine-second driving ping synchronizes three emphasized steam puffs', () => {
    const audio = captureAudio();
    try {
        const train = spawnTrain(point(0,-600)); route(point(0,700));
        const plannedTime = train.pingTimer; assert.ok(plannedTime >= 5 && plannedTime <= 9);
        while (train.runningTime + 1 / 60 < plannedTime) step();
        assert.equal(audio.pings(),0);
        step(2); assert.equal(audio.pings(),1);
        assert.equal(train.steam.filter(puff => puff.emphasized && puff.life > 1.1).length,3);
        assert.ok(train.pingTimer >= 5 - 1 / 60 && train.pingTimer <= 9);
        beginTrainRoute(); const pings = audio.pings(); step(200);
        assert.equal(audio.pings(),pings); assert.ok(train.steam.every(puff => puff.life === 0));
    } finally { audio.close(); }
});

reset(); console.log(`\n${passed} train checks passed.`);
