import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, explodingBricks } from '../js/state.js';
import { animals, GROUP_ANIMALS, spawnDog, clearAllAnimals, updateDogs, setGrabbedAnimal, removeAnimalImmediately, triggerClickAction } from '../js/entities.js';
import { placeVoxel, explodeBricks, disposeExplodingBrick } from '../js/scene.js';
import { awakenBlocks } from '../js/living.js';
import { clearAllFood } from '../js/food.js';
import { applySnack, updateMagicEffects } from '../js/magic.js';
import { spawnTrain, clearTrain, beginTrainRoute, appendTrainRoutePoint, finishTrainRoute, cancelTrainRoute, updateTrain, MAX_TRAIN_ROUTE_POINTS, MAX_TRAIN_ROUTE_LENGTH } from '../js/train.js';

const point = (x, z, y = 0) => new THREE.Vector3(x, y, z);
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
        state.world.step(1 / 60); updateTrain(1 / 60); updateDogs(1 / 60); updateMagicEffects(animals, 1 / 60);
    }
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

test('nearby friends join nearest first with a delay between admissions', () => {
    const far = pet('dog', -210,0), near = pet('cat', -70,0), middle = pet('rabbit', -140,0);
    const train = spawnTrain(point(0,0)); route(point(0,700));
    step(); assert.deepEqual(train.followers, [near]);
    step(20); assert.deepEqual(train.followers, [near]);
    step(22); assert.deepEqual(train.followers, [near,middle]);
    step(42); assert.deepEqual(train.followers, [near,middle,far]);
    assert.ok(train.followers.every(animal => animal.trainRide?.train === train));
});

test('friends near a moving tail can join later', () => {
    const first = pet('dog',0,-70); const train = spawnTrain(point(0,0)); route(point(0,700)); step(180);
    const late = pet('cat',first.body.position.x - 120,first.body.position.z);
    step(50); assert.deepEqual(train.followers,[first,late]);
});

test('followers traverse the actual train corner instead of a diagonal shortcut', () => {
    const animal = pet('dog',0,-90); const train = spawnTrain(point(0,0)); route(point(0,400),point(400,400),point(400,0));
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

test('larger living block friends receive more room in the tail', () => {
    const normal = pet('dog',0,-75);
    const seed = placeVoxel(point(25,-200,25),null,true);
    placeVoxel(point(75,-200,25),null,true); placeVoxel(point(125,-200,25),null,true);
    const { animal: large } = awakenBlocks(seed);
    large.state = 'idle'; large.timer = 1000;
    const train = spawnTrain(point(0,0)); route(point(0,650)); step(90);
    assert.deepEqual(train.followers,[normal,large]);
    assert.ok(large.trainRide.followDistance - normal.trainRide.followDistance > 125);
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

test('swept routes reject walls and movement remains within the board', () => {
    const train = spawnTrain(point(0,0));
    for (let y = 25; y <= 225; y += 50) placeVoxel(point(0,200,y),null,true);
    beginTrainRoute(); assert.equal(appendTrainRoutePoint(point(0,500)),false);
    assert.equal(train.route.length,1); cancelTrainRoute();
    for (let index = 0; index < 900; index++) {
        step(); assert.ok(Math.abs(train.position.x) <= 832 && Math.abs(train.position.z) <= 832);
        assert.ok(!(Math.abs(train.position.x) < 93 && train.position.z > 107 && train.position.z < 293));
    }
});

test('new walls stop a running route without tunneling or destroying blocks', () => {
    const train = spawnTrain(point(0,0)); route(point(0,600)); step(20);
    const wall = placeVoxel(point(0,200,25),null,true); const count = objects.length;
    step(180); assert.ok(objects.includes(wall)); assert.equal(objects.length,count);
    assert.ok(!(Math.abs(train.position.x) < 93 && train.position.z > 107 && train.position.z < 293));
});

test('route samples, length and magical lights have bounded lifetimes', () => {
    const train = spawnTrain(point(0,0)); beginTrainRoute();
    for (let i = 1; i < 1000; i++) appendTrainRoutePoint(point((i % 2) * 25,Math.floor(i / 2) % 2 ? 25 : 0));
    assert.ok(train.route.length <= MAX_TRAIN_ROUTE_POINTS); assert.ok(train.draftLength <= MAX_TRAIN_ROUTE_LENGTH);
    assert.equal(finishTrainRoute(),true); assert.ok(train.pathVisual);
    step(205); assert.equal(train.pathVisual,null);
});

test('train friends never hunt or flee, including a predator waiting to join', () => {
    const predator = pet('bear',-50,0), prey = pet('rabbit',-170,0);
    const train = spawnTrain(point(0,0)); route(point(0,700));
    updateTrain(1 / 60); assert.equal(train.followers[0],predator); assert.ok(predator.trainRide.joining);
    updateDogs(1 / 60); assert.equal(prey.state,'idle'); assert.equal(prey.body.velocity.x,0);
    step(50); assert.ok(prey.trainRide); assert.equal(predator.trainRide.train,prey.trainRide.train);
    triggerClickAction(predator); assert.equal(predator.clickActionTimer,0);
});

test('even unjoined animals remain friends while a train exists, and normal fear returns after removal', () => {
    const predator = pet('bear',500,0), prey = pet('rabbit',650,0);
    spawnTrain(point(-500,0)); updateDogs(1 / 60);
    assert.equal(predator.trainRide,undefined); assert.equal(prey.trainRide,undefined);
    assert.equal(prey.state,'idle'); assert.equal(prey.body.velocity.x,0);
    clearTrain(); updateDogs(1 / 60);
    assert.equal(prey.state,'walking'); assert.ok(prey.body.velocity.x > 0);
});

test('a friend in front steps aside before joining rather than walking through the locomotive', () => {
    const animal = pet('dog',0,200); animal.speed = 400;
    const train = spawnTrain(point(0,0)); route(point(0,700));
    for (let i = 0; i < 240; i++) {
        step();
        const trainBox = new THREE.Box3().setFromObject(train.mesh), animalBox = new THREE.Box3().setFromObject(animal.mesh);
        assert.ok(!trainBox.intersectsBox(animalBox), `joined through engine at ${i / 60}s`);
    }
    assert.ok(animal.trainRide && !animal.trainRide.joining);
});

test('a large tail candidate cannot strand the locomotive in a narrow clearance', () => {
    placeVoxel(point(100,0,25),null,true);
    pet('dog',0,-550);
    const train = spawnTrain(point(0,-400)); route(point(0,650));
    while (train.position.z < 0) step();
    const seed = placeVoxel(point(-50,-300,25),null,true);
    placeVoxel(point(0,-300,25),null,true); placeVoxel(point(50,-300,25),null,true);
    const { animal: large } = awakenBlocks(seed); large.state = 'idle'; large.timer = 1000;
    train.recruitTimer = 0;
    const before = train.position.clone(); step(); assert.equal(large.trainRide,undefined);
    step(150); assert.ok(train.position.distanceTo(before) > 100);
});

test('a passenger that grows near the board edge lets the convoy safely retreat instead of freezing', () => {
    const seed = placeVoxel(point(-150,0,25),null,true);
    placeVoxel(point(-100,0,25),null,true); placeVoxel(point(-50,0,25),null,true);
    const { animal } = awakenBlocks(seed); animal.state = 'idle'; animal.timer = 1000;
    const train = spawnTrain(point(0,0)); route(point(800,0),point(800,500));
    for (let i = 0; i < 500 && train.position.x < 797; i++) step();
    assert.ok(animal.trainRide); const before = train.position.clone();
    applySnack(animal,['balloon']); step(180);
    assert.ok(train.position.distanceTo(before) > 30);
    assert.ok(train.position.x < before.x - 10);
    assert.ok(animal.trainRide);
});

test('balloon passengers keep the 40 percent speed cap and the train slows to their pace', () => {
    const animal = pet('dog',0,-80); const train = spawnTrain(point(0,0)); route(point(0,700));
    applySnack(animal,['balloon']);
    let previous = point(animal.body.position.x,animal.body.position.z);
    for (let i = 0; i < 240; i++) {
        step(); const next = point(animal.body.position.x,animal.body.position.z);
        assert.ok(next.distanceTo(previous) <= animal.speed * 0.4 / 60 + 1e-6);
        assert.ok(Math.hypot(animal.body.velocity.x,animal.body.velocity.z) <= animal.speed * 0.4 + 1e-6);
        previous = next;
    }
    assert.ok(animal.trainRide); assert.ok(train.speed <= animal.speed * 0.4);
    assert.ok(animal.mesh.getObjectByName('snack-balloon-shell'));
});

test('grabbing, deleting and clearing release follower references and owned train resources', () => {
    const first = pet('dog',-60,0), second = pet('cat',-130,0); const train = spawnTrain(point(0,0)); route(point(0,600)); step(50);
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

reset(); console.log(`\n${passed} train checks passed.`);
