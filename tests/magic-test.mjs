import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects } from '../js/state.js';
import { SNACK_INGREDIENTS, normalizeIngredients, describeRecipe, applySnack, updateMagicEffects, clearMagicEffect } from '../js/magic.js';
import { spawnFood, clearAllFood, initFoodGhost, showFoodGhost, hideFoodGhost } from '../js/food.js';
import { animals, GROUP_ANIMALS, spawnDog, clearAllAnimals, updateDogs } from '../js/entities.js';

const created = [];
function reset() {
    created.splice(0).forEach(clearMagicEffect);
    clearAllAnimals();
    clearAllFood();
    objects.length = 0;
    state.scene = new THREE.Scene();
    state.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -1470, 0) });
    state.plane = null;
    state.snackIngredients = [];
    state.actionHistory = [];
    state.actionRedoStack = [];
    state.onToyNotice = undefined;
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    state.world.addBody(ground);
}
function animal(compound = false) {
    const mesh = new THREE.Group();
    const body = new CANNON.Body({ mass: 10, fixedRotation: true, linearDamping: 0.95 });
    const material = new THREE.MeshStandardMaterial({ color: 0x699bed, roughness: 0.7 });
    for (const x of compound ? [-65, 65] : [0]) {
        const part = new THREE.Mesh(new THREE.BoxGeometry(30, 40, 30), material);
        part.position.set(x, 20, 0);
        mesh.add(part);
        body.addShape(new CANNON.Box(new CANNON.Vec3(15, 20, 15)), new CANNON.Vec3(x, 0, 0));
    }
    body.position.set(0, 20, 0);
    state.scene.add(mesh);
    state.world.addBody(body);
    const result = { mesh, body, baseScale: new THREE.Vector3(1, 1, 1), heightOffset: 8, targetDir: new THREE.Vector3(1, 0, 0), state: 'idle', timer: 10, speed: 220 };
    created.push(result);
    return result;
}
function block(x, y, z, width = 50, height = 50, depth = 50) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshBasicMaterial());
    mesh.position.set(x, y, z);
    state.scene.add(mesh);
    objects.push(mesh);
    const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)) });
    body.position.set(x, y, z);
    state.world.addBody(body);
    return mesh;
}
function step(list = created, dt = 1 / 60) {
    state.world.step(dt);
    list.forEach(item => {
        item.mesh.position.copy(item.body.position);
        item.mesh.position.y -= item.heightOffset * 2.5;
    });
    updateMagicEffects(list, dt);
}
function trailMeshes() { return state.scene.children.filter(item => item.userData.magicTrail); }
const tests = [];
function test(name, fn) { reset(); fn(); tests.push(name); }

test('recipes admit at most two unique known ingredients and preserve caller arrays', () => {
    const ids = ['jelly', 'unknown', 'jelly', 'balloon', 'rainbow'];
    assert.deepEqual(normalizeIngredients(ids), ['jelly', 'balloon']);
    assert.deepEqual(ids, ['jelly', 'unknown', 'jelly', 'balloon', 'rainbow']);
    assert.deepEqual(normalizeIngredients(null), []);
    assert.deepEqual(normalizeIngredients('balloon'), []);
    assert.equal(SNACK_INGREDIENTS.length, 3);
    assert.equal(describeRecipe([]), '사과');
    assert.match(describeRecipe(['jelly', 'balloon']), /젤리.*풍선/);
});

test('every recipe displays its ingredients and stores its own immutable selection copy', () => {
    for (const ids of [[], ['balloon'], ['jelly'], ['rainbow'], ['balloon', 'jelly'], ['balloon', 'rainbow'], ['jelly', 'rainbow']]) {
        const selected = [...ids];
        const food = spawnFood(new THREE.Vector3(), selected);
        const visible = new Set();
        food.mesh.traverse(mesh => { if (mesh.userData.snackIngredient) visible.add(mesh.userData.snackIngredient); });
        for (const id of ids) assert.ok(visible.has(id), `${ids}: ${id}`);
        selected.push('invalid');
        assert.deepEqual(food.ingredients, ids);
        assert.ok(new THREE.Box3().setFromObject(food.mesh).min.y >= -1e-8);
    }
    state.snackIngredients = ['jelly'];
    assert.deepEqual(spawnFood(new THREE.Vector3()).ingredients, ['jelly']);
});

test('preview replacement follows selection and disposes every old resource', () => {
    initFoodGhost();
    const original = state.scene.children.at(-1);
    const geometrySet = new Set(), materialSet = new Set();
    original.traverse(child => { if (child.geometry) geometrySet.add(child.geometry); if (child.material) materialSet.add(child.material); });
    let disposed = 0;
    for (const resource of [...geometrySet, ...materialSet]) resource.addEventListener('dispose', () => disposed++);
    state.snackIngredients = ['balloon', 'jelly'];
    showFoodGhost(12, 34, 56);
    const next = state.scene.children.at(-1);
    assert.equal(original.parent, null);
    assert.equal(disposed, geometrySet.size + materialSet.size);
    assert.deepEqual(next.userData.ingredients, ['balloon', 'jelly']);
    assert.deepEqual(next.position.toArray(), [12, 34, 56]);
    assert.equal(next.visible, true);
    hideFoodGhost();
    assert.equal(next.visible, false);
});

test('plain apple and timed expiry restore exact original scale and material references', () => {
    const pet = animal();
    const originalMaterial = pet.mesh.children[0].material;
    const originalShape = pet.body.shapes[0];
    const damping = pet.body.linearDamping;
    applySnack(pet, ['balloon', 'jelly']);
    const effect = pet.magicEffect;
    const copies = [...effect.materialCopies];
    let disposed = 0;
    copies.forEach(material => material.addEventListener('dispose', () => disposed++));
    step();
    assert.notDeepEqual(pet.mesh.scale.toArray(), [1, 1, 1]);
    applySnack(pet, []);
    assert.equal(pet.magicEffect, undefined);
    assert.deepEqual(pet.mesh.scale.toArray(), [1, 1, 1]);
    assert.equal(pet.mesh.children[0].material, originalMaterial);
    assert.equal(pet.mesh.children.length, 1);
    assert.equal(disposed, copies.length);
    assert.equal(pet.body.shapes[0], originalShape);
    assert.equal(pet.body.linearDamping, damping);
    assert.equal(pet.body.hasEventListener('collide', effect.onCollide), false);
    applySnack(pet, ['rainbow']);
    for (let i = 0; i < 1199; i++) updateMagicEffects([pet], 1 / 60);
    assert.ok(pet.magicEffect);
    updateMagicEffects([pet], 1 / 60);
    assert.equal(pet.magicEffect, undefined);
    assert.equal(pet.mesh.children[0].material, originalMaterial);
});

test('feeding again refreshes the timer without accumulating scale or listeners', () => {
    const pet = animal();
    for (let i = 0; i < 8; i++) {
        applySnack(pet, ['balloon', 'jelly']);
        updateMagicEffects([pet], 1);
        assert.ok(pet.mesh.scale.x < 1.7);
        assert.equal(pet.mesh.children.length, 2);
    }
    assert.equal(pet.magicEffect.remaining, 19);
    assert.equal(pet.body._listeners.collide.length, 1);
    applySnack(pet, ['rainbow']);
    assert.equal(pet.body._listeners.collide.length, 0);
    assert.equal(pet.mesh.children.length, 1);
});

test('balloon floats near a 160-unit foot height using the real Cannon world', () => {
    const pet = animal();
    applySnack(pet, ['balloon']);
    for (let i = 0; i < 360; i++) step();
    const bounds = new THREE.Box3().setFromObject(pet.mesh);
    assert.ok(bounds.min.y > 120 && bounds.min.y < 205, `foot height ${bounds.min.y}`);
    assert.ok(Number.isFinite(pet.body.position.y));
    applySnack(pet, []);
    for (let i = 0; i < 180; i++) step();
    assert.ok(Math.abs(pet.body.position.y - 20) < 2);
});

test('balloon and mixed balloon jelly stay below a low ceiling without passing through', () => {
    for (const recipe of [['balloon'], ['balloon', 'jelly']]) {
        const pet = animal();
        block(0, 120, 0, 300, 40, 300);
        applySnack(pet, recipe);
        for (let i = 0; i < 360; i++) {
            step([pet]);
            const bounds = new THREE.Box3().setFromObject(pet.mesh);
            assert.ok(bounds.max.y <= 100 + 0.1, `${recipe}: top ${bounds.max.y}`);
            assert.ok(bounds.min.y >= -0.1, `${recipe}: bottom ${bounds.min.y}`);
        }
        clearMagicEffect(pet);
        pet.mesh.removeFromParent();
        state.world.removeBody(pet.body);
    }
});

test('compound animals retain every shape and stay on the board while floating', () => {
    const pet = animal(true);
    const shapes = [...pet.body.shapes];
    pet.body.position.x = 990;
    pet.mesh.position.x = 990;
    applySnack(pet, ['balloon', 'jelly']);
    for (let i = 0; i < 120; i++) { pet.body.velocity.x = 450; step(); }
    const bounds = new THREE.Box3().setFromObject(pet.mesh);
    assert.ok(bounds.max.x <= 1000 + 0.1, `edge ${bounds.max.x}`);
    assert.deepEqual(pet.body.shapes, shapes);
});

test('jelly visibly rebounds from a physical side wall and bounces on landing', () => {
    const pet = animal();
    block(55, 150, 0, 30, 300, 300);
    pet.body.position.y = 80;
    pet.mesh.position.y = 60;
    applySnack(pet, ['jelly']);
    pet.body.velocity.x = 300;
    let reflected = false, bounces = 0, priorVy = pet.body.velocity.y;
    for (let i = 0; i < 240; i++) {
        step();
        if (pet.body.velocity.x < -100) reflected = true;
        if (priorVy <= 30 && pet.body.velocity.y > 200) bounces++;
        priorVy = pet.body.velocity.y;
    }
    assert.ok(reflected, 'side collision should kick the pet away from the wall');
    assert.ok(bounces >= 2, `landing bounces ${bounces}`);
});

test('rainbow footprints expire and never enter build objects, history or physics', () => {
    const pet = animal();
    applySnack(pet, ['rainbow']);
    const bodyCount = state.world.bodies.length;
    for (let i = 0; i < 120; i++) {
        pet.body.position.x = i * 3;
        pet.mesh.position.x = i * 3;
        updateMagicEffects([pet], 1 / 60);
    }
    assert.ok(trailMeshes().length > 5);
    assert.equal(objects.length, 0);
    assert.equal(state.actionHistory.length, 0);
    assert.equal(state.actionRedoStack.length, 0);
    assert.equal(state.world.bodies.length, bodyCount);
    updateMagicEffects([pet], 5.1);
    assert.equal(trailMeshes().length, 0);
});

test('rainbow footprint caps and deletion clean both shared geometry and all materials', () => {
    const pets = Array.from({ length: 10 }, () => animal());
    pets.forEach(pet => applySnack(pet, ['rainbow']));
    for (let i = 0; i < 250; i++) {
        pets.forEach((pet, j) => { pet.body.position.set(Math.sin(i * 0.25) * 800, 20, j * 20); pet.mesh.position.set(pet.body.position.x, 0, j * 20); });
        updateMagicEffects(pets, 1 / 60);
    }
    const footprints = trailMeshes();
    assert.ok(footprints.length > 100 && footprints.length <= 240);
    let disposedMaterials = 0, disposedGeometry = 0;
    footprints.forEach(mesh => mesh.material.addEventListener('dispose', () => disposedMaterials++));
    footprints[0].geometry.addEventListener('dispose', () => disposedGeometry++);
    updateMagicEffects([], 1 / 60);
    assert.equal(trailMeshes().length, 0);
    assert.equal(disposedMaterials, footprints.length);
    assert.equal(disposedGeometry, 1);
    pets.forEach(pet => assert.equal(pet.magicEffect, undefined));
});

test('held pets keep the grab position while their game-time duration still elapses', () => {
    const pet = animal();
    pet.grabbed = true;
    pet.body.position.set(222, 444, 333);
    pet.mesh.position.set(222, 424, 333);
    applySnack(pet, ['balloon', 'jelly']);
    updateMagicEffects([pet], 3);
    assert.deepEqual(pet.body.position.toArray(), [222, 444, 333]);
    assert.equal(pet.magicEffect.remaining, 17);
    assert.equal(trailMeshes().length, 0);
    updateMagicEffects([pet], NaN);
    assert.equal(pet.magicEffect.remaining, 17);
});

test('all 33 real animal models obey the 40 percent horizontal cap during AI, food pursuit and click dash', () => {
    for (const type of GROUP_ANIMALS.all) {
        clearAllAnimals();
        clearAllFood();
        GROUP_ANIMALS.magicTest = [type];
        const pet = spawnDog('magicTest');
        delete GROUP_ANIMALS.magicTest;
        const halfHeight = pet.heightOffset * 2.5;
        const originalSpeed = pet.speed;
        pet.body.position.set(0, halfHeight, 0);
        pet.mesh.position.set(0, 0, 0);
        pet.body.velocity.set(0, 0, 0);
        pet.state = 'walking';
        pet.timer = 10;
        pet.targetDir.set(1, 0, 0);
        applySnack(pet, ['balloon', 'rainbow']);
        for (let i = 0; i < 300; i++) {
            if (i === 120) spawnFood(new THREE.Vector3(850, 0, 0), []);
            if (i === 210) { pet.clickActionType = 'dash'; pet.clickActionTimer = 0.7; pet.clickActionPhase = 0; }
            state.world.step(1 / 60);
            updateDogs(1 / 60);
            updateMagicEffects(animals, 1 / 60);
            assert.ok(Math.hypot(pet.body.velocity.x, pet.body.velocity.z) <= originalSpeed * 0.4 + 1e-8, `${type}: speed cap at frame ${i}`);
            assert.equal(pet.speed, originalSpeed, `${type}: unchanged base speed`);
        }
        const bounds = new THREE.Box3().setFromObject(pet.mesh);
        assert.ok(bounds.min.y > 90 && bounds.min.y < 240, `${type}: foot ${bounds.min.y}`);
        assert.ok(bounds.min.x >= -1000 && bounds.max.x <= 1000, `${type}: board`);
    }
});

test('balloon drift accelerates, brakes and reverses smoothly with rate independent timing', () => {
    function run(hz) {
        const pet = animal();
        applySnack(pet, ['balloon']);
        const velocity = [];
        for (let i = 0; i < hz; i++) {
            pet.body.velocity.x = i < hz / 2 ? 900 : -900;
            pet.body.velocity.z = i < hz / 2 ? 900 : -900;
            updateMagicEffects([pet], 1 / hz);
            velocity.push(new THREE.Vector3(pet.body.velocity.x, 0, pet.body.velocity.z));
            assert.ok(velocity.at(-1).length() <= pet.speed * 0.4 + 1e-8);
        }
        const afterReverse = velocity[Math.floor(hz / 2)];
        assert.ok(afterReverse.x > 0, 'reversing the AI direction should first slow the old drift');
        assert.ok(velocity.at(-1).x < 0, 'the drift should complete the direction change');
        const beforeBrake = velocity.at(-1).length();
        pet.body.velocity.set(0, 0, 0);
        updateMagicEffects([pet], 0.1);
        const afterBrake = Math.hypot(pet.body.velocity.x, pet.body.velocity.z);
        assert.ok(afterBrake > 0 && afterBrake < beforeBrake, 'stopping should glide to rest');
        return velocity.at(-1);
    }
    const reference = run(60);
    for (const hz of [30, 144]) assert.ok(run(hz).distanceTo(reference) < 1e-8, `${hz} Hz drift response`);
});

test('balloon and jelly wall rebound remain capped even after an extreme flee or dash command', () => {
    const pet = animal();
    pet.speed = 160;
    pet.body.position.y = 180;
    pet.mesh.position.y = 160;
    applySnack(pet, ['balloon', 'jelly']);
    let sawReversal = false;
    for (let i = 0; i < 120; i++) {
        state.world.step(1 / 60);
        pet.mesh.position.copy(pet.body.position).setY(pet.body.position.y - 20);
        pet.body.velocity.set(5000, 1200, 5000);
        if (i >= 30 && i < 60) pet.magicEffect.pendingWall = new THREE.Vector3(-1, 0, 0);
        updateMagicEffects([pet], 1 / 60);
        assert.ok(Math.hypot(pet.body.velocity.x, pet.body.velocity.z) <= 64 + 1e-8);
        if (pet.body.velocity.x < 0) sawReversal = true;
    }
    assert.ok(sawReversal, 'mixed jelly retains its reflected wall motion');
});

test('real fleeing prey remains slow while a predator approaches', () => {
    GROUP_ANIMALS.magicPrey = ['dog'];
    const pet = spawnDog('magicPrey');
    delete GROUP_ANIMALS.magicPrey;
    GROUP_ANIMALS.magicPredator = ['lion'];
    const predator = spawnDog('magicPredator');
    delete GROUP_ANIMALS.magicPredator;
    pet.body.position.set(0, pet.heightOffset * 2.5 + 160, 0);
    pet.mesh.position.set(0, 160, 0);
    pet.state = 'walking';
    pet.timer = 10;
    applySnack(pet, ['balloon']);
    for (let i = 0; i < 120; i++) {
        predator.body.position.set(pet.body.position.x - 100, predator.heightOffset * 2.5, pet.body.position.z);
        state.world.step(1 / 60);
        updateDogs(1 / 60);
        updateMagicEffects(animals, 1 / 60);
        assert.ok(Math.hypot(pet.body.velocity.x, pet.body.velocity.z) <= pet.speed * 0.4 + 1e-8);
    }
    assert.ok(pet.body.position.x > 30, 'prey should still flee, at the slower balloon pace');
});

test('refeeding does not compound slowdown and apple, replacement or expiry release the cap', () => {
    GROUP_ANIMALS.magicTest = ['dog'];
    const pet = spawnDog('magicTest');
    delete GROUP_ANIMALS.magicTest;
    const originalSpeed = pet.speed;
    for (let pass = 0; pass < 5; pass++) {
        pet.body.velocity.set(originalSpeed, 0, 0);
        applySnack(pet, ['balloon']);
        assert.ok(Math.abs(pet.body.velocity.x - originalSpeed * 0.4) < 1e-8);
        updateMagicEffects(animals, 0.1);
        assert.equal(pet.speed, originalSpeed);
        assert.ok(Math.abs(pet.body.velocity.x - originalSpeed * 0.4) < 1e-8);
    }
    for (const clear of [() => applySnack(pet, []), () => applySnack(pet, ['rainbow']), () => updateMagicEffects(animals, 20)]) {
        applySnack(pet, ['balloon']);
        clear();
        pet.clickActionTimer = 0;
        pet.isEating = false;
        pet.state = 'walking';
        pet.timer = 10;
        pet.targetDir.set(1, 0, 0);
        pet.body.position.set(0, pet.heightOffset * 2.5, 0);
        pet.body.velocity.set(0, 0, 0);
        updateDogs(1 / 60);
        updateMagicEffects(animals, 1 / 60);
        assert.equal(pet.speed, originalSpeed);
        assert.ok(Math.abs(Math.hypot(pet.body.velocity.x, pet.body.velocity.z) - originalSpeed) < 1e-8);
    }
});

test('balloon bob has a slow 3.6 second period and ignores jump animation offsets', () => {
    const pet = animal();
    applySnack(pet, ['balloon']);
    const samples = [];
    for (let i = 0; i < 900; i++) {
        state.world.step(1 / 60);
        pet.mesh.position.copy(pet.body.position);
        pet.mesh.position.y -= 20;
        // Emulate the rapid mesh hop and click impulses that normal animal AI
        // applies before the magic pass. Neither should disturb the slow bob.
        pet.mesh.position.y += Math.abs(Math.sin(i * 0.7)) * 90;
        if (i % 30 === 0) pet.body.velocity.y = 1200;
        updateMagicEffects([pet], 1 / 60);
        assert.equal(pet.mesh.position.y, pet.body.position.y - 20);
        assert.ok(Number.isFinite(pet.body.velocity.y));
        if (i > 240) samples.push({ time: i / 60, y: pet.body.position.y });
    }
    const peaks = [];
    for (let i = 1; i < samples.length - 1; i++) {
        if (samples[i].y > samples[i - 1].y && samples[i].y >= samples[i + 1].y) peaks.push(samples[i].time);
    }
    assert.ok(peaks.length >= 2, `bob peaks ${peaks.length}`);
    for (let i = 1; i < peaks.length; i++) assert.ok(Math.abs(peaks[i] - peaks[i - 1] - 3.6) < 0.08, `period ${peaks[i] - peaks[i - 1]}`);
    const range = Math.max(...samples.map(item => item.y)) - Math.min(...samples.map(item => item.y));
    assert.ok(range > 20 && range < 45, `gentle bob range ${range}`);
});

test('living compound yaw follows smooth drift and clearing restores the original tilt', () => {
    const pet = animal(true);
    pet.livingId = 'magic-compound';
    pet.mesh.rotation.x = 0.08;
    pet.mesh.rotation.z = -0.04;
    pet.body.position.x = 850;
    pet.mesh.position.x = 850;
    applySnack(pet, ['balloon']);
    for (let i = 0; i < 180; i++) {
        state.world.step(1 / 60);
        pet.body.velocity.set(500, pet.body.velocity.y, 500);
        pet.mesh.position.copy(pet.body.position).setY(pet.body.position.y - 20);
        updateMagicEffects([pet], 1 / 60);
        const expected = new CANNON.Quaternion();
        expected.setFromEuler(0, pet.mesh.rotation.y, 0);
        const alignment = ['x', 'y', 'z', 'w'].reduce((sum, axis) => sum + pet.body.quaternion[axis] * expected[axis], 0);
        assert.ok(Math.abs(alignment) > 1 - 1e-8);
        const bounds = new THREE.Box3().setFromObject(pet.mesh);
        assert.ok(bounds.max.x <= 1000 + 0.1 && bounds.max.z <= 1000 + 0.1);
    }
    clearMagicEffect(pet);
    assert.equal(pet.mesh.rotation.x, 0.08);
    assert.equal(pet.mesh.rotation.z, -0.04);
});

test('missing or invalid custom speed stays finite and a zero speed remains stationary', () => {
    for (const speed of [undefined, NaN, Infinity, -10, 0]) {
        const pet = animal();
        pet.speed = speed;
        pet.body.velocity.set(Infinity, 0, NaN);
        applySnack(pet, ['balloon']);
        for (let i = 0; i < 30; i++) {
            pet.body.velocity.set(1000, 0, 1000);
            updateMagicEffects([pet], 1 / 60);
            const actualSpeed = Math.hypot(pet.body.velocity.x, pet.body.velocity.z);
            assert.ok(Number.isFinite(actualSpeed));
            assert.ok(actualSpeed <= (speed === 0 ? 0 : 88) + 1e-8);
        }
        assert.equal(pet.speed, speed);
    }
});

reset();
console.log(JSON.stringify({ passed: tests.length, tests }, null, 2));
