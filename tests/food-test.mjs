import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { state, objects } from '../js/state.js';
import { foods, spawnFood, triggerFoodFall, updateFoods, removeFoodWithEffect, clearAllFood, clearAllFoodWithEffect } from '../js/food.js';

const raf = [];
let now = performance.now();
globalThis.requestAnimationFrame = callback => { raf.push(callback); return raf.length; };
function flush() {
    now = Math.max(now, performance.now());
    for (let i = 0; raf.length && i < 200; i++) { now += 1000 / 60; raf.splice(0).forEach(callback => callback(now)); }
    assert.equal(raf.length, 0);
}
function reset() {
    clearAllFood(); flush();
    objects.length = 0;
    state.scene = new THREE.Scene();
    state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    state.scene.add(state.plane); objects.push(state.plane);
    state.scene.updateMatrixWorld(true);
}
function block(x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50), new THREE.MeshBasicMaterial());
    mesh.position.set(x, y, z); state.scene.add(mesh); objects.push(mesh); mesh.updateMatrixWorld(true);
    return mesh;
}
function watchResources(food) {
    const geometries = new Set(), materials = new Set();
    food.mesh.traverse(child => { if (child.geometry) geometries.add(child.geometry); if (child.material) materials.add(child.material); });
    let g = 0, m = 0;
    geometries.forEach(geometry => geometry.addEventListener('dispose', () => g++));
    materials.forEach(material => material.addEventListener('dispose', () => m++));
    return () => { assert.equal(g, geometries.size); assert.equal(m, materials.size); assert.equal(food.mesh.parent, null); };
}
const tests = [];
function test(name, fn) { reset(); fn(); tests.push(name); }

test('high velocity food cannot tunnel through a 50-unit platform', () => {
    block(0, 125, 0);
    const food = spawnFood(new THREE.Vector3(0, 200, 0));
    triggerFoodFall(food, -30000);
    updateFoods(1 / 60);
    assert.equal(food.position.y, 150);
    assert.equal(food.mesh.position.y, 150);
    assert.ok(food.fallVelocity > 0);
});
test('falling food settles at floor zero with and without a raycast floor', () => {
    for (const usePlane of [true, false]) {
        if (!usePlane) { objects.length = 0; state.plane = null; }
        const food = spawnFood(new THREE.Vector3(0, 400, 0));
        triggerFoodFall(food);
        for (let i = 0; i < 600; i++) updateFoods(1 / 60);
        assert.ok(Math.abs(food.position.y) < 1e-8);
        assert.equal(food.falling, false);
        assert.equal(food.fallVelocity, 0);
        clearAllFood();
    }
});
test('upper platforms above the starting food do not teleport it upward', () => {
    block(0, 325, 0); block(0, 75, 0);
    const food = spawnFood(new THREE.Vector3(0, 200, 0));
    triggerFoodFall(food, -30000);
    updateFoods(1 / 60);
    assert.equal(food.position.y, 100);
});
test('consumed food disposes every unique geometry/material once', () => {
    const food = spawnFood(new THREE.Vector3());
    const check = watchResources(food);
    food.eaten = true; food.consumeTimer = 2;
    for (let i = 0; i < 130; i++) updateFoods(1 / 60);
    assert.equal(foods.length, 0); check();
    clearAllFood(); check();
});
test('zero consume timer completes removal', () => {
    const food = spawnFood(new THREE.Vector3());
    const check = watchResources(food);
    food.consumeTimer = 0;
    updateFoods(1 / 60);
    assert.equal(foods.length, 0); check();
});
test('clear during single removal effect cannot double dispose resources', () => {
    const food = spawnFood(new THREE.Vector3());
    const check = watchResources(food);
    removeFoodWithEffect(food); removeFoodWithEffect(food);
    assert.equal(foods.length, 0);
    clearAllFood(); check(); flush(); check(); clearAllFood(); check();
});
test('clear during bulk removal cleans every pending effect exactly once', () => {
    const checks = [];
    for (let i = 0; i < 4; i++) checks.push(watchResources(spawnFood(new THREE.Vector3(i * 50, 0, 0))));
    clearAllFoodWithEffect(); clearAllFood(); flush(); clearAllFood();
    checks.forEach(check => check());
    assert.deepEqual(state.scene.children, [state.plane]);
});
test('completed removal animations release resources', () => {
    const food = spawnFood(new THREE.Vector3());
    const check = watchResources(food);
    removeFoodWithEffect(food); flush(); check();
});
test('fall triggers leave consumed/removed food unchanged', () => {
    const food = spawnFood(new THREE.Vector3());
    food.eaten = true; food.consumeTimer = 2;
    triggerFoodFall(food); assert.equal(food.falling, false);
    clearAllFood(); triggerFoodFall(food); assert.equal(food.falling, false);
});

const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const animationSource = main.slice(main.indexOf('const fixedDt = '), main.lastIndexOf('\ninit();'));
function runAnimation(fps, gameSpeed, seconds = 1) {
    let steps = 0, animalTime = 0, foodTime = 0;
    const simulationState = {
        gameSpeed, world: { step(dt) { assert.equal(dt, 1 / 60); steps++; } },
        camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} },
        velocity: new THREE.Vector3(), keys: {}, screenShakeTimer: 0,
        composer: { render() {} },
    };
    const context = vm.createContext({
        THREE, state: simulationState, requestAnimationFrame() {}, explodingBricks: [],
        updateDogs(dt) { animalTime += dt; }, updateFoods(dt) { foodTime += dt; },
        disposeExplodingBrick() {}, updatePreview() {},
    });
    vm.runInContext(animationSource, context);
    context.animate(0);
    for (let i = 1; i <= fps * seconds; i++) context.animate(i * 1000 / fps);
    return { steps, animalTime, foodTime, context, simulationState, getSteps: () => steps };
}
test('main simulation is consistent at 30/60/144 Hz and x1/x2/x3', () => {
    for (const fps of [30, 60, 144]) for (const speed of [1, 2, 3]) {
        const result = runAnimation(fps, speed);
        assert.equal(result.steps, speed * 60, `${fps}Hz x${speed}`);
        assert.ok(Math.abs(result.animalTime - speed) < 1e-8);
        assert.ok(Math.abs(result.foodTime - speed) < 1e-8);
    }
});
test('main clamps long frame gaps to bounded fixed physics steps', () => {
    const result = runAnimation(60, 3);
    result.context.animate(120000);
    assert.equal(result.getSteps(), 198);
    assert.ok(Number.isFinite(result.simulationState.camera.position.x));
});
test('camera shake never accumulates into the real camera position', () => {
    const result = runAnimation(60, 1);
    result.simulationState.camera.position.set(500, 800, 1300);
    result.simulationState.screenShakeTimer = 0.5;
    result.simulationState.screenShakeIntensity = 36;
    for (let i = 61; i <= 90; i++) result.context.animate(i * 1000 / 60);
    assert.ok(result.simulationState.camera.position.distanceTo(new THREE.Vector3(500, 800, 1300)) < 1e-8);
});
reset();
console.log(JSON.stringify({ passed: tests.length, tests }, null, 2));
