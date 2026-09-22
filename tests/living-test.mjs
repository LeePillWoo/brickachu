import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, explodingBricks } from '../js/state.js';
import { placeVoxel, pushHistory, undo, redo, getFullSnapshot, explodeBricks, restoreBricks, disposeExplodingBrick } from '../js/scene.js';
import { animals, MAX_ANIMALS, grabbedAnimal, setGrabbedAnimal, clearAllAnimals, spawnDog, removeAnimalImmediately, removeAnimalWithEffect, removeAllAnimalsWithEffect, updateDogs } from '../js/entities.js';
import { foods, spawnFood, clearAllFoodWithEffect } from '../js/food.js';
import { awakenBlocks, collectConnectedBlocks, classifyLivingShape, MAX_LIVING_BLOCKS } from '../js/living.js';
import { applySnack, updateMagicEffects } from '../js/magic.js';

const raf = [];
globalThis.requestAnimationFrame = callback => { raf.push(callback); return raf.length; };
function flush() { for (let step = 0; raf.length && step < 200; step++) raf.splice(0).forEach(callback => callback()); }
function reset() {
    flush();
    clearAllAnimals();
    while (explodingBricks.length) disposeExplodingBrick(explodingBricks.pop());
    foods.length = 0;
    objects.length = 0;
    explodingBricks.length = 0;
    state.scene = new THREE.Scene();
    state.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -1470, 0) });
    state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    state.scene.add(state.plane);
    objects.push(state.plane);
    const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    state.world.addBody(floor);
    state.previewScene = new THREE.Scene();
    state.previewObjects.length = 0;
    state.actionHistory.length = 0;
    state.actionRedoStack.length = 0;
    state.isRestoringHistory = false;
    materials['preset-0'] = new THREE.MeshPhysicalMaterial({ color: 0xffad22, roughness: 0.3 });
    state.currentSlot = 'preset-0';
    pushHistory();
}
const block = (x = 25, y = 25, z = 25) => placeVoxel(new THREE.Vector3(x, y, z), 'preset-0', true);
let passed = 0;
function test(name, fn) { reset(); fn(); passed++; console.log(`PASS ${name}`); }

test('only face-connected blocks awaken; diagonal and detached builds stay put', () => {
    const seed = block();
    const touching = block(75);
    const diagonal = block(125, 75);
    const detached = block(-125);
    assert.deepEqual(collectConnectedBlocks(seed), [seed, touching]);
    const result = awakenBlocks(seed, new THREE.Vector3(0, 0, 1));
    assert.equal(result.ok, true);
    assert.deepEqual(objects.slice(1), [diagonal, detached]);
    assert.equal(result.animal.body.shapes.length, 2);
    assert.equal(state.previewObjects.length, 2);
    assert.equal(state.world.bodies.length, 4);
});

test('oversize builds reject atomically, without removing blocks or recording history', () => {
    const seed = block();
    for (let i = 1; i <= MAX_LIVING_BLOCKS; i++) block(25 + i * 50);
    pushHistory();
    const before = getFullSnapshot();
    const historyCount = state.actionHistory.length;
    assert.equal(collectConnectedBlocks(seed).length, MAX_LIVING_BLOCKS + 1);
    assert.equal(awakenBlocks(seed).ok, false);
    assert.equal(getFullSnapshot(), before);
    assert.equal(state.actionHistory.length, historyCount);
});

test('full playground rejects creation without evicting friends or eating blocks', () => {
    for (let i = 0; i < MAX_ANIMALS; i++) spawnDog('quad');
    const seed = block();
    const original = [...animals];
    assert.equal(awakenBlocks(seed).ok, false);
    assert.deepEqual(animals, original);
    assert.ok(objects.includes(seed));
});

test('a build longer than the play area allowance rejects without consuming blocks', () => {
    const seed = block();
    for (let i = 1; i < 13; i++) block(25 + i * 50);
    assert.equal(awakenBlocks(seed).ok, false);
    assert.equal(objects.length - 1, 13);
    assert.equal(animals.length, 0);
});

test('tall, flat, chunky and compact builds get their matching abilities', () => {
    assert.equal(classifyLivingShape(new THREE.Vector3(50, 150, 50), 3), 'HOP');
    assert.equal(classifyLivingShape(new THREE.Vector3(150, 50, 50), 3), 'SNEAK');
    assert.equal(classifyLivingShape(new THREE.Vector3(150, 150, 100), 18), 'HEAVY');
    assert.equal(classifyLivingShape(new THREE.Vector3(50, 50, 50), 1), 'WADDLE');
});

test('selected side owns real 3D eyes, and all blocks keep their world positions', () => {
    const seed = block();
    block(75);
    block(75, 75);
    const expected = objects.slice(1).map(item => item.position.toArray().join(',')).sort();
    const { animal } = awakenBlocks(seed, new THREE.Vector3(-1, 0, 0));
    const actual = animal.mesh.children.filter(child => child.name === 'living-voxel')
        .map(child => child.getWorldPosition(new THREE.Vector3()).toArray().map(value => Math.round(value)).join(',')).sort();
    assert.deepEqual(actual, expected);
    assert.equal(animal.livingEyes.children.length, 2);
    assert.ok(animal.livingEyes.children.every(eye => eye.children.length === 4 && eye.children.every(child => child.isMesh)));
    const eyeCenter = animal.livingEyes.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(eyeCenter.x + 1) < 0.001);
    assert.equal(animal.mesh.children[0].material.color.getHex(), 0xffad22);
    assert.ok(Object.isFrozen(animal.livingDescriptor.blocks[0].pos));
});

test('top-face eyes remain on the chosen face', () => {
    const { animal } = awakenBlocks(block(), new THREE.Vector3(0, 1, 0));
    const center = animal.livingEyes.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(center.y - 51) < 0.001);
    const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(animal.livingEyes.quaternion);
    assert.ok(outward.distanceTo(new THREE.Vector3(0, 1, 0)) < 0.001);
});

test('one undo restores every original block, one redo restores a single friend', () => {
    const originalAnimal = spawnDog('quad');
    const seed = block();
    block(25, 75);
    pushHistory();
    const historyCount = state.actionHistory.length;
    const { animal } = awakenBlocks(seed);
    assert.equal(state.actionHistory.length, historyCount + 1);
    undo();
    assert.equal(objects.length - 1, 2);
    assert.deepEqual(animals, [originalAnimal]);
    redo();
    assert.equal(objects.length - 1, 0);
    assert.equal(animals.length, 2);
    assert.equal(animals[1].livingId, animal.livingId);
    assert.equal(state.world.bodies.length, 3);
    undo();
    redo();
    assert.equal(animals.length, 2);
});

test('undo of an unrelated build preserves a moving friend and does not duplicate its blocks', () => {
    const { animal } = awakenBlocks(block());
    const initialSnapshot = getFullSnapshot();
    animal.body.position.set(300, 200, 400);
    animal.mesh.position.set(300, 175, 400);
    animal.body.velocity.set(20, 30, 40);
    assert.equal(getFullSnapshot(), initialSnapshot);
    block(500);
    pushHistory();
    undo();
    assert.equal(animals[0], animal);
    assert.deepEqual(animal.body.position.toArray(), [300, 200, 400]);
    assert.deepEqual(animal.body.velocity.toArray(), [20, 30, 40]);
    assert.equal(objects.length - 1, 0);
});

test('deleting a friend is undoable without reviving the original blocks alongside it', () => {
    const { animal } = awakenBlocks(block());
    removeAnimalWithEffect(animal);
    flush();
    assert.equal(animals.length, 0);
    undo();
    assert.equal(animals.length, 1);
    assert.equal(objects.length - 1, 0);
    redo();
    assert.equal(animals.length, 0);
});

test('history preserves friends above capacity and a new summon restores the cap in age order', () => {
    const { animal } = awakenBlocks(block());
    removeAnimalWithEffect(animal);
    flush();
    for (let i = 0; i < MAX_ANIMALS; i++) spawnDog('quad');
    const ordinary = [...animals];
    undo();
    assert.equal(animals.length, MAX_ANIMALS + 1);
    assert.ok(ordinary.every(friend => animals.includes(friend)));
    assert.equal(animals.filter(friend => friend.livingId).length, 1);
    const restored = [...animals];
    const added = spawnDog('quad');
    assert.ok(added);
    assert.deepEqual(animals, [...restored.slice(2), added]);
    assert.equal(animals.length, MAX_ANIMALS);
});

test('replacing the oldest block friend records its removal without reviving editable blocks', () => {
    const { animal } = awakenBlocks(block());
    for (let i = 1; i < MAX_ANIMALS; i++) spawnDog('quad');
    const added = spawnDog('quad');
    assert.ok(added);
    assert.equal(animals.length, MAX_ANIMALS);
    assert.ok(!animals.includes(animal));
    assert.equal(animal.mesh.parent, null);
    assert.equal(objects.length, 1);
    undo();
    assert.equal(animals.length, MAX_ANIMALS + 1);
    assert.ok(animals.some(friend => friend.livingId === animal.livingId));
    assert.equal(objects.length, 1);
    redo();
    assert.equal(animals.length, MAX_ANIMALS);
    assert.ok(!animals.some(friend => friend.livingId));
});

test('custom cleanup disposes owned resources once and leaves shared palette intact', () => {
    const { animal } = awakenBlocks(block());
    let sharedDisposals = 0;
    state.cubeGeo.addEventListener('dispose', () => sharedDisposals++);
    materials['preset-0'].addEventListener('dispose', () => sharedDisposals++);
    const geometry = animal.mesh.children[0].geometry;
    const material = animal.mesh.children[0].material;
    assert.notEqual(geometry, state.cubeGeo);
    assert.notEqual(material, materials['preset-0']);
    let ownedDisposals = 0;
    geometry.addEventListener('dispose', () => ownedDisposals++);
    material.addEventListener('dispose', () => ownedDisposals++);
    removeAnimalImmediately(animal);
    assert.equal(sharedDisposals, 0);
    assert.equal(ownedDisposals, 2);
    assert.equal(state.world.bodies.length, 1);
});

test('custom friends blink and settle on the physical floor with finite transforms', () => {
    const seed = block();
    block(25, 75);
    block(25, 125);
    const { animal } = awakenBlocks(seed);
    animal.livingBlinkIn = 0;
    updateDogs(0.09);
    assert.ok(animal.livingEyes.children[0].scale.y < 0.1);
    for (let i = 0; i < 120; i++) {
        state.world.step(1 / 60);
        updateDogs(1 / 60);
    }
    assert.notEqual(animal.state, 'falling');
    assert.ok(Number.isFinite(animal.body.position.y));
    assert.ok(animal.body.position.y >= 70);
    assert.ok(Math.abs(animal.livingEyes.children[0].scale.y - 1) < 0.001);
});

test('wide living friends stay wholly inside the board when they reach an edge', () => {
    const seed = block();
    for (let i = 1; i < 12; i++) block(25 + i * 50);
    const { animal } = awakenBlocks(seed);
    animal.body.position.set(950, 25, 0);
    animal.body.velocity.set(100, 0, 0);
    animal.state = 'idle';
    animal.timer = 10;
    updateDogs(1 / 60);
    animal.body.updateAABB();
    assert.ok(animal.body.aabb.upperBound.x <= 1000);
    assert.ok(animal.body.aabb.lowerBound.x >= -1000);
});

test('bomb explodes a living-only scene into blocks at their current transformed positions', () => {
    const seed = block();
    block(25, 75);
    const { animal } = awakenBlocks(seed);
    animal.mesh.position.set(350, 120, -250);
    animal.mesh.rotation.set(0.12, 0.7, -0.1);
    animal.body.position.set(350, 170, -250);
    applySnack(animal, ['balloon', 'jelly']);
    updateMagicEffects(animals, 0.1);
    animal.mesh.updateMatrixWorld(true);
    const expected = animal.mesh.children.filter(child => child.name === 'living-voxel').map(child => ({
        position: child.getWorldPosition(new THREE.Vector3()),
        quaternion: child.getWorldQuaternion(new THREE.Quaternion()),
        scale: child.getWorldScale(new THREE.Vector3()),
        color: child.material.color.getHex()
    }));
    animal.grabbed = true;
    setGrabbedAnimal(animal);
    const originalBody = animal.body;
    const beforeHistory = state.actionHistory.length;
    explodeBricks();
    assert.equal(animals.length, 0);
    assert.equal(objects.length, 1);
    assert.equal(explodingBricks.length, 2);
    assert.equal(state.actionHistory.length, beforeHistory + 1);
    assert.equal(grabbedAnimal, null);
    assert.equal(animal.grabbed, false);
    assert.equal(animal.magicEffect, undefined);
    assert.ok(!state.world.bodies.includes(originalBody));
    explodingBricks.forEach((part, index) => {
        assert.ok(part.mesh.position.distanceTo(expected[index].position) < 1e-8);
        assert.ok(1 - Math.abs(part.mesh.quaternion.dot(expected[index].quaternion)) < 1e-8);
        assert.ok(part.mesh.scale.distanceTo(expected[index].scale) < 1e-8);
        assert.ok(part.baseScale.distanceTo(expected[index].scale) < 1e-8);
        assert.equal(part.mesh.material.color.getHex(), expected[index].color);
        assert.ok(part.body.velocity.y > 0);
        assert.equal(part.mesh.userData.animalRef, undefined);
    });
});

test('bomb undo, redo and repeated restore never duplicate living friends or original blocks', () => {
    const seed = block();
    block(25, 75);
    const { animal } = awakenBlocks(seed);
    const staticBlock = block(525);
    pushHistory();
    explodeBricks();
    assert.equal(explodingBricks.length, 3);
    undo();
    assert.equal(explodingBricks.length, 0);
    assert.equal(animals.length, 1);
    assert.equal(animals[0].livingId, animal.livingId);
    assert.equal(objects.length - 1, 1);
    assert.deepEqual(objects[1].position.toArray(), staticBlock.position.toArray());
    assert.equal(state.world.bodies.length, 3);
    redo();
    assert.equal(animals.length, 0);
    assert.equal(objects.length - 1, 0);
    assert.equal(state.world.bodies.length, 1);
    restoreBricks();
    restoreBricks();
    assert.equal(animals.length, 1);
    assert.equal(objects.length - 1, 1);
    assert.equal(state.world.bodies.length, 3);
});

test('mixed bomb clears magical animals, keeps falling food, and disposes each owned resource once', () => {
    const seed = block();
    block(25, 75);
    const { animal: living } = awakenBlocks(seed);
    const ordinary = spawnDog('quad');
    const ordinaryGeometries = new Set(), ordinaryMaterials = new Set();
    ordinary.mesh.traverse(child => {
        if (child.geometry) ordinaryGeometries.add(child.geometry);
        if (child.material) ordinaryMaterials.add(child.material);
    });
    let ordinaryGeometryDisposals = 0, ordinaryMaterialDisposals = 0;
    ordinaryGeometries.forEach(geometry => geometry.addEventListener('dispose', () => ordinaryGeometryDisposals++));
    ordinaryMaterials.forEach(material => material.addEventListener('dispose', () => ordinaryMaterialDisposals++));
    block(525);
    const food = spawnFood(new THREE.Vector3(525, 50, 25));
    applySnack(living, ['balloon', 'rainbow']);
    applySnack(ordinary, ['jelly', 'rainbow']);
    let paletteDisposals = 0;
    const paletteListener = () => paletteDisposals++;
    state.cubeGeo.addEventListener('dispose', paletteListener);
    materials['preset-0'].addEventListener('dispose', paletteListener);
    explodeBricks();
    assert.equal(animals.length, 0);
    assert.equal(living.magicEffect, undefined);
    assert.equal(ordinary.magicEffect, undefined);
    assert.equal(explodingBricks.length, 4);
    assert.equal(foods.length, 1);
    assert.equal(food.falling, true);
    const wrappers = explodingBricks.filter(part => part.ownsMeshResources);
    assert.equal(wrappers.length, 1);
    wrappers[0].mesh.traverse(child => assert.equal(child.userData.animalRef, undefined));
    const resources = explodingBricks.find(part => part.fragmentResources).fragmentResources;
    let geometryDisposals = 0, materialDisposals = 0;
    resources.geometries.forEach(geometry => geometry.addEventListener('dispose', () => geometryDisposals++));
    resources.materials.forEach(material => material.addEventListener('dispose', () => materialDisposals++));
    const again = [...explodingBricks];
    while (explodingBricks.length) disposeExplodingBrick(explodingBricks.pop());
    again.forEach(disposeExplodingBrick);
    updateMagicEffects(animals, 1 / 60);
    assert.equal(paletteDisposals, 0);
    assert.equal(geometryDisposals, resources.geometries.length);
    assert.equal(materialDisposals, resources.materials.length);
    assert.equal(ordinaryGeometryDisposals, ordinaryGeometries.size);
    assert.equal(ordinaryMaterialDisposals, ordinaryMaterials.size);
    assert.equal(state.world.bodies.length, 1);
    assert.ok(!state.scene.children.some(child => child.name.startsWith('exploding-') || child.name === 'snack-rainbow-footprint'));
    state.cubeGeo.removeEventListener('dispose', paletteListener);
    materials['preset-0'].removeEventListener('dispose', paletteListener);
});

test('ordinary animals also explode when no build blocks remain', () => {
    const animal = spawnDog('quad');
    const oldBody = animal.body;
    explodeBricks();
    assert.equal(animals.length, 0);
    assert.equal(explodingBricks.length, 1);
    assert.equal(explodingBricks[0].mesh.name, 'exploding-animal');
    assert.ok(!state.world.bodies.includes(oldBody));
    assert.ok(explodingBricks[0].body.velocity.y > 0);
    disposeExplodingBrick(explodingBricks.pop());
    assert.equal(state.world.bodies.length, 1);
});

test('bulk clear removes magical living friends, regular animals and food together', () => {
    const { animal: living } = awakenBlocks(block());
    const ordinary = spawnDog('quad');
    spawnFood(new THREE.Vector3(525, 0, 25));
    applySnack(living, ['balloon', 'rainbow']);
    applySnack(ordinary, ['jelly']);
    living.grabbed = true;
    setGrabbedAnimal(living);
    removeAllAnimalsWithEffect();
    clearAllFoodWithEffect();
    flush();
    updateMagicEffects(animals, 1 / 60);
    assert.equal(animals.length, 0);
    assert.equal(foods.length, 0);
    assert.equal(grabbedAnimal, null);
    assert.equal(living.magicEffect, undefined);
    assert.equal(ordinary.magicEffect, undefined);
    assert.equal(living.mesh.parent, null);
    assert.equal(ordinary.mesh.parent, null);
    assert.equal(state.world.bodies.length, 1);
    undo();
    assert.equal(animals.length, 1);
    assert.equal(animals[0].livingId, living.livingId);
    assert.equal(objects.length - 1, 0);
});

console.log(`\n${passed} living-block checks passed.`);
