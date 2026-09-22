import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects } from '../js/state.js';
import { animals, GROUP_ANIMALS, spawnDog, clearAllAnimals, updateDogs, triggerClickAction, setGrabbedAnimal, removeAnimalImmediately, detachAnimalsForExplosion, disposeAnimalMesh } from '../js/entities.js';
import { clearAllFood, spawnFood, updateFoods } from '../js/food.js';
import { applySnack, clearMagicEffect, updateMagicEffects } from '../js/magic.js';
import { clearTrain, spawnTrain, updateTrain } from '../js/train.js';
import { getAnimalPowerInfo, triggerAnimalPower, updateAnimalPowers, clearAnimalPower, clearAllPowerDecorations } from '../js/animal-powers.js';

function reset() {
    clearAllPowerDecorations(); clearTrain(); clearAllAnimals(); clearAllFood(); objects.length = 0;
    state.scene = new THREE.Scene(); state.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -1470, 0) });
    state.groundMaterial = new CANNON.Material('ground'); state.animalMaterial = new CANNON.Material('animal');
    state.world.addContactMaterial(new CANNON.ContactMaterial(state.groundMaterial, state.animalMaterial, { friction: 0.4, restitution: 0.1 }));
    state.world.addContactMaterial(new CANNON.ContactMaterial(state.animalMaterial, state.animalMaterial, { friction: 0.3, restitution: 0.2 }));
    state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    state.scene.add(state.plane); objects.push(state.plane);
    const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: state.groundMaterial }); floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0); state.world.addBody(floor);
    state.actionHistory.length = 0; state.actionRedoStack.length = 0; state.onToyNotice = null;
    state.scene.updateMatrixWorld(true);
}
function pet(type, x = 0, z = 0) {
    GROUP_ANIMALS.powerTest = [type]; const animal = spawnDog('powerTest'); delete GROUP_ANIMALS.powerTest;
    animal.body.position.set(x, animal.heightOffset * 2.5, z); animal.mesh.position.set(x, 0, z);
    animal.body.velocity.set(0, 0, 0); animal.mesh.rotation.set(0, 0, 0);
    animal.state = 'idle'; animal.timer = 1000; animal.speed = 160;
    return animal;
}
function step(count = 1) {
    for (let i = 0; i < count; i++) {
        state.world.step(1 / 60); updateTrain(1 / 60); updateDogs(1 / 60); updateFoods(1 / 60); updateMagicEffects(animals, 1 / 60);
    }
}
function decorations(name) {
    const matches = [];
    state.scene.traverse(mesh => { if (mesh.userData.animalPowerDecoration && (!name || mesh.name === name)) matches.push(mesh); });
    return matches;
}
let passed = 0;
function test(name, fn) { reset(); fn(); console.log(`  ✓ ${name}`); passed++; }

test('six new powers and three existing refinements expose useful Korean descriptions', () => {
    for (const type of ['otter', 'panda', 'octopus', 'crab', 'hedgehog', 'baby-dragon', 'penguin', 'elephant', 'snail']) {
        const info = getAnimalPowerInfo(type); assert.ok(info.name && info.description);
    }
    assert.equal(getAnimalPowerInfo('unknown'), null);
});

test('otter water slides carry a grounded friend, leave floating friends alone and expire', () => {
    const otter = pet('otter'), friend = pet('dog', 300, 300), balloon = pet('cat', -300, 300);
    applySnack(balloon, ['balloon']); triggerClickAction(otter);
    assert.equal(otter.animalPower.controlsMotion, true);
    step(30);
    const water = decorations('animal-water-slide')[0]; assert.ok(water);
    friend.body.position.set(water.position.x, friend.heightOffset * 2.5, water.position.z);
    balloon.body.position.set(water.position.x + 20, balloon.heightOffset * 2.5, water.position.z);
    updateAnimalPowers(animals, 1 / 60);
    assert.equal(friend.animalPower?.source, otter); assert.equal(balloon.animalPower, undefined);
    step(70); assert.ok(otter.body.position.z > 100);
    step(450);
    assert.equal(otter.animalPower, undefined); assert.equal(friend.animalPower, undefined);
    assert.equal(decorations('animal-water-slide').length, 0);
});

test('panda rolls through six toy pins and cleanup removes every pin', () => {
    const panda = pet('panda'); triggerClickAction(panda);
    const power = panda.animalPower;
    assert.notEqual(panda.body.material, state.animalMaterial);
    assert.equal(power.pins.length, 6);
    step(80);
    assert.ok(power.pins.some(pin => pin.knocked));
    assert.ok(Math.abs(panda.mesh.rotation.x) > 1);
    step(80); assert.equal(panda.animalPower, undefined); assert.equal(panda.body.material, state.animalMaterial);
    assert.ok(Math.abs(panda.mesh.rotation.x) < 0.001);
    clearAnimalPower(panda); assert.equal(decorations().length, 0);
});

test('octopus paint is a temporary shell and never changes a shared block or its saved color', () => {
    const octopus = pet('octopus');
    const originalMaterial = new THREE.MeshStandardMaterial({ color: 0x7dcea0 });
    const geometry = new THREE.BoxGeometry(50, 50, 50);
    const block = new THREE.Mesh(geometry, originalMaterial), sibling = new THREE.Mesh(geometry, originalMaterial);
    block.position.set(80, 25, 0); sibling.position.set(400, 25, 0);
    state.scene.add(block, sibling); objects.push(block, sibling); state.scene.updateMatrixWorld(true);
    let originalDisposals = 0;
    geometry.addEventListener('dispose', () => originalDisposals++); originalMaterial.addEventListener('dispose', () => originalDisposals++);
    triggerClickAction(octopus); step(15);
    assert.equal(decorations('animal-block-paint').length, 1);
    const shell = decorations('animal-block-paint')[0]; assert.notEqual(shell.geometry, geometry);
    assert.equal(block.material, originalMaterial); assert.equal(sibling.material.color.getHex(), 0x7dcea0);
    objects.splice(objects.indexOf(block), 1); block.removeFromParent(); step();
    assert.equal(shell.parent, null); assert.equal(originalDisposals, 0);
    clearAnimalPower(octopus); assert.equal(originalDisposals, 0);
});

test('crab carries the actual selected snack, prevents premature eating and feeds its recipient', () => {
    const crab = pet('crab'), friend = pet('dog', 0, 300);
    const food = spawnFood(new THREE.Vector3(0, 0, 25), ['jelly']);
    triggerClickAction(crab); assert.equal(food.carriedBy, crab);
    step(10); assert.equal(food.eaten, false); assert.ok(food.mesh.position.y > crab.body.position.y);
    let delivered = false;
    for (let i = 0; i < 210; i++) { step(); if (friend.magicEffect?.ingredients.includes('jelly')) { delivered = true; break; } }
    assert.ok(delivered); assert.equal(food.carriedBy, undefined); assert.equal(food.eaten, true); assert.equal(crab.animalPower, undefined);
});

test('cancelled crab delivery drops the snack safely and no-food taps create nothing', () => {
    const crab = pet('crab'); let notice = ''; state.onToyNotice = text => { notice = text; };
    triggerClickAction(crab); assert.match(notice, /간식/); assert.equal(crab.animalPower, undefined);
    pet('dog', 0, 400); const food = spawnFood(new THREE.Vector3(0, 0, 25)); triggerClickAction(crab);
    setGrabbedAnimal(crab); assert.equal(food.carriedBy, undefined); assert.equal(food.falling, true);
    step(180); assert.equal(food.falling, false); assert.equal(food.position.y, 0);
});

test('crab cannot collect or deliver through a wall, or collect an unreachable high snack', () => {
    const crab = pet('crab'), friend = pet('dog', 0, 200);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(200, 180, 20), new THREE.MeshBasicMaterial());
    wall.position.set(0, 90, 80); state.scene.add(wall); objects.push(wall); state.scene.updateMatrixWorld(true);
    const beyond = spawnFood(new THREE.Vector3(0, 0, 150));
    triggerClickAction(crab); assert.equal(crab.animalPower, undefined); assert.equal(beyond.carriedBy, undefined);
    clearAllFood(); const high = spawnFood(new THREE.Vector3(0, 150, 0)); triggerClickAction(crab);
    assert.equal(high.carriedBy, undefined); clearAllFood();
    const food = spawnFood(new THREE.Vector3(0, 0, 20)); triggerClickAction(crab); assert.equal(food.carriedBy, crab);
    friend.body.position.z = 100; crab.body.position.z = 50;
    updateAnimalPowers(animals, 1 / 60); assert.equal(food.eaten, false);
    clearAnimalPower(crab); assert.equal(crab.body.material, state.animalMaterial);
});

test('hedgehog flowers bloom on its back and remain cosmetic, bounded and temporary', () => {
    const hedgehog = pet('hedgehog'); triggerClickAction(hedgehog);
    assert.equal(hedgehog.mesh.children.filter(child => child.userData.animalPowerDecoration).length, 3);
    step(20); assert.ok(decorations('animal-flower-trail').length > 0);
    assert.equal(objects.length, 1); assert.equal(state.world.bodies.length, 2);
    step(100); assert.equal(hedgehog.mesh.children.filter(child => child.userData.animalPowerDecoration).length, 0);
    step(480); assert.equal(decorations().length, 0);
});

test('dragon bubble reuses floating exclusions, ignores existing transformations and pops on the friend tap', () => {
    const dragon = pet('baby-dragon'), transformed = pet('cat', 80, 0), friend = pet('dog', 170, 0);
    const modelBounds = new THREE.Box3().setFromObject(friend.mesh).translate(friend.mesh.position.clone().negate());
    applySnack(transformed, ['jelly']); const previousEffect = transformed.magicEffect;
    triggerClickAction(dragon);
    assert.equal(transformed.magicEffect, previousEffect); assert.equal(friend.magicEffect.powerBubble, true);
    assert.equal(friend.magicEffect.remaining, 6);
    const shell = friend.magicEffect.decoration;
    assert.equal(shell.scale.x, shell.scale.y); assert.equal(shell.scale.x, shell.scale.z);
    for (const x of [modelBounds.min.x, modelBounds.max.x]) for (const y of [modelBounds.min.y, modelBounds.max.y]) for (const z of [modelBounds.min.z, modelBounds.max.z]) {
        assert.ok(shell.position.distanceTo(new THREE.Vector3(x, y, z)) < shell.scale.x);
    }
    assert.ok(friend.magicEffect.localBounds.containsPoint(shell.position.clone().add(shell.scale)));
    assert.ok(friend.magicEffect.localBounds.containsPoint(shell.position.clone().sub(shell.scale)));
    const bubble = friend.magicEffect; spawnFood(new THREE.Vector3(170, 0, 0));
    let traveled = 0;
    for (let i = 0; i < 50; i++) {
        const before = new THREE.Vector3().copy(friend.body.position); step();
        traveled += Math.hypot(friend.body.position.x - before.x, friend.body.position.z - before.z);
        assert.ok(Math.hypot(friend.body.velocity.x, friend.body.velocity.z) <= Math.min(friend.speed * 0.12, 36) + 1e-8);
    }
    assert.ok(traveled < 30, 'dragon bubbles also drift gently instead of keeping ground movement speed');
    assert.equal(friend.magicEffect, bubble); assert.equal(friend.isEating, false);
    assert.ok(friend.body.position.y > friend.heightOffset * 2.5 + 50);
    triggerClickAction(friend); assert.equal(friend.magicEffect, undefined);
});

test('removing or grabbing a dragon cancels its bubble without clearing a newer snack', () => {
    const dragon = pet('baby-dragon'), friend = pet('dog', 170, 0);
    triggerClickAction(dragon); setGrabbedAnimal(dragon); assert.equal(friend.magicEffect, undefined);
    dragon.powerCooldown = 0; triggerClickAction(dragon); assert.ok(friend.magicEffect?.powerBubble);
    applySnack(friend, ['rainbow']); const replacement = friend.magicEffect;
    removeAnimalImmediately(dragon); assert.equal(friend.magicEffect, replacement);
});

test('powers pause on zero delta and active motion prevents immediate train recruitment', () => {
    const panda = pet('panda', 0, 100); triggerClickAction(panda);
    const remaining = panda.animalPower.remaining, count = decorations().length;
    updateAnimalPowers(animals, 0); updateAnimalPowers(animals, NaN);
    assert.equal(panda.animalPower.remaining, remaining); assert.equal(decorations().length, count);
    spawnTrain(new THREE.Vector3(0, 0, 0)); updateTrain(0.1);
    assert.equal(panda.trainRide, undefined); clearTrain();
    const activePower = panda.animalPower; triggerClickAction(panda); assert.equal(panda.animalPower, activePower);
});

test('direct snacks cancel rolling and bloom decorations before capturing magic pose and materials', () => {
    const panda = pet('panda'); triggerClickAction(panda); step(25);
    assert.ok(Math.abs(panda.mesh.rotation.x) > 1);
    applySnack(panda, ['balloon']);
    assert.equal(panda.animalPower, undefined); assert.equal(panda.body.material, state.animalMaterial);
    assert.ok(Math.abs(panda.magicEffect.originalTilt.x) < 0.001);
    clearMagicEffect(panda); assert.ok(Math.abs(panda.mesh.rotation.x) < 0.001);
    const hedgehog = pet('hedgehog', 300, 0); triggerClickAction(hedgehog);
    const flowers = hedgehog.mesh.children.filter(child => child.userData.animalPowerDecoration);
    const resources = new Set(); flowers.forEach(root => root.traverse(child => { if (child.geometry) resources.add(child.geometry); if (child.material) resources.add(child.material); }));
    let disposed = 0; resources.forEach(resource => resource.addEventListener('dispose', () => disposed++));
    applySnack(hedgehog, ['jelly']); assert.equal(disposed, resources.size);
    assert.equal(hedgehog.animalPower, undefined); assert.ok(flowers.every(f => !f.parent));
    clearMagicEffect(hedgehog); assert.equal(disposed, resources.size);
});

test('all removal paths dispose powers and decorations without leftover references', () => {
    const hedgehog = pet('hedgehog'), octopus = pet('octopus', -200, 0), dragon = pet('baby-dragon', 200, 0);
    pet('dog', 400, 0);
    triggerClickAction(hedgehog); triggerClickAction(octopus); triggerClickAction(dragon); step(15);
    assert.ok(decorations().length > 0);
    const resources = new Set();
    for (const root of decorations()) root.traverse(mesh => { if (mesh.geometry) resources.add(mesh.geometry); if (mesh.material) resources.add(mesh.material); });
    let disposed = 0; resources.forEach(resource => resource.addEventListener('dispose', () => disposed++));
    clearAllAnimals();
    assert.equal(decorations().length, 0); assert.equal(disposed, resources.size);
    assert.equal(animals.length, 0); assert.equal(state.world.bodies.length, 1);
});

test('bomb transfer clears active toys, restores physics, releases carried food and leaves fragments independent', () => {
    const panda = pet('panda', -600, 0), hedgehog = pet('hedgehog', -300, 0), dragon = pet('baby-dragon', 200, 0);
    const bubbleFriend = pet('dog', 400, 0), crab = pet('crab', 0, 500); pet('cat', 200, 500);
    const food = spawnFood(new THREE.Vector3(0, 0, 520));
    [panda, hedgehog, dragon, crab].forEach(triggerClickAction); step(10);
    assert.ok(panda.animalPower && hedgehog.animalPower && dragon.animalPower && crab.animalPower);
    assert.ok(bubbleFriend.magicEffect.powerBubble); assert.equal(food.carriedBy, crab);
    const pieces = detachAnimalsForExplosion();
    assert.equal(pieces.length, 6); assert.equal(animals.length, 0); assert.equal(state.world.bodies.length, 1);
    assert.equal(panda.body.material, state.animalMaterial); assert.equal(crab.body.material, state.animalMaterial);
    assert.equal(food.carriedBy, undefined); assert.equal(food.falling, true); assert.equal(bubbleFriend.magicEffect, undefined);
    assert.equal(decorations().length, 0);
    const transforms = pieces.map(({ mesh }) => {
        mesh.updateWorldMatrix(true, true);
        return [mesh.matrixWorld.toArray(), mesh.children[0].matrixWorld.toArray()];
    });
    updateDogs(1); updateMagicEffects(animals, 1); clearAllPowerDecorations();
    pieces.forEach(({ mesh }, index) => {
        mesh.updateWorldMatrix(true, true);
        assert.deepEqual([mesh.matrixWorld.toArray(), mesh.children[0].matrixWorld.toArray()], transforms[index]);
        mesh.traverse(child => assert.equal(child.userData.animalRef, undefined));
        disposeAnimalMesh(mesh);
    });
});

test('penguin, elephant, snail and turtle retain useful click behavior', () => {
    for (const [type, powerType] of [['penguin', 'slide'], ['elephant', 'sprinkle'], ['snail', 'paint']]) {
        const animal = pet(type); assert.equal(triggerAnimalPower(animal, animals), true); assert.equal(animal.animalPower.type, powerType); clearAnimalPower(animal);
    }
    const turtle = pet('turtle'); assert.equal(triggerAnimalPower(turtle, animals), false); triggerClickAction(turtle); assert.equal(turtle.clickActionType, 'spin');
});

reset(); console.log(`\n${passed} animal power checks passed.`);
