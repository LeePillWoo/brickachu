import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, explodingBricks, materials } from '../js/state.js';
import * as entities from '../js/entities.js';
import { foods, spawnFood, clearAllFood } from '../js/food.js';
import { applySnack, updateMagicEffects } from '../js/magic.js';

const raf = [];
globalThis.requestAnimationFrame = callback => { raf.push(callback); return raf.length; };
const flush = () => { for (let i = 0; raf.length && i < 200; i++) raf.splice(0).forEach(callback => callback()); assert.equal(raf.length, 0); };
function reset() {
    flush();
    entities.clearAllAnimals();
    foods.length = 0;
    objects.length = 0;
    explodingBricks.length = 0;
    state.scene = new THREE.Scene();
    state.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -1470, 0) });
    state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
    state.scene.add(state.plane);
    objects.push(state.plane);
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    state.world.addBody(ground);
    state.scene.updateMatrixWorld(true);
    state.previewScene = new THREE.Scene();
    state.previewObjects.length = 0;
    state.onToyNotice = null;
    materials['preset-0'] = new THREE.MeshBasicMaterial();
}
function spawn(type) {
    entities.GROUP_ANIMALS.test = [type];
    const animal = entities.spawnDog('test');
    delete entities.GROUP_ANIMALS.test;
    return animal;
}
function standing(type, x = 0, z = 0) {
    const animal = spawn(type);
    const halfHeight = animal.heightOffset * 2.5;
    animal.body.position.set(x, halfHeight, z);
    animal.body.velocity.set(0, 0, 0);
    animal.mesh.position.set(x, 0, z);
    animal.mesh.rotation.set(0, 0, 0);
    animal.state = 'idle';
    animal.timer = 10;
    return animal;
}
function block(x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50), materials['preset-0']);
    mesh.position.set(x, y, z);
    mesh.userData.slot = 'preset-0';
    state.scene.add(mesh);
    objects.push(mesh);
    mesh.updateMatrixWorld(true);
    return mesh;
}
const tests = [];
function test(name, fn) { reset(); fn(); tests.push(name); }

test('random pool contains each animal exactly once', () => {
    assert.equal(new Set(entities.GROUP_ANIMALS.all).size, entities.GROUP_ANIMALS.all.length);
});
test('capacity replaces the oldest friend and disposes only its resources', () => {
    for (let i = 0; i < entities.MAX_ANIMALS; i++) spawn('dog');
    assert.equal(entities.MAX_ANIMALS, 30);
    const original = [...entities.animals];
    const notices = [];
    state.onToyNotice = notice => notices.push(notice);
    const disposals = original.map(() => 0);
    original.forEach((animal, index) => animal.mesh.traverse(part => part.geometry?.addEventListener('dispose', () => disposals[index]++)));
    const added = spawn('rabbit');
    assert.deepEqual(entities.animals, [...original.slice(1), added]);
    assert.equal(original[0].mesh.parent, null);
    assert.ok(!state.world.bodies.includes(original[0].body));
    assert.ok(disposals[0] > 0 && disposals.slice(1).every(count => count === 0));
    assert.equal(state.world.bodies.length, entities.MAX_ANIMALS + 1);
    assert.equal(notices.length, 0);
    const next = spawn('cat');
    assert.deepEqual(entities.animals, [...original.slice(2), added, next]);
});
test('removing one friend at capacity permits one new friend without replacing others', () => {
    for (let i = 0; i < entities.MAX_ANIMALS; i++) spawn('dog');
    entities.removeAnimalImmediately(entities.animals[4]);
    const remaining = [...entities.animals];
    const added = spawn('rabbit');
    assert.equal(entities.animals.length, entities.MAX_ANIMALS);
    assert.ok(added && entities.animals.includes(added));
    assert.ok(remaining.every(animal => entities.animals.includes(animal)));
});
test('carnivore limit rejects without evicting an existing animal', () => {
    for (let i = 0; i < entities.MAX_ANIMALS - 4; i++) spawn('dog');
    for (let i = 0; i < 4; i++) entities.spawnDog('carnivore');
    const original = [...entities.animals];
    entities.spawnDog('carnivore');
    assert.deepEqual(entities.animals, original);
    assert.equal(state.world.bodies.length, entities.MAX_ANIMALS + 1);
});
test('all 26 model types spawn and settle on the physical floor', () => {
    for (const type of entities.GROUP_ANIMALS.all) {
        entities.clearAllAnimals();
        const animal = spawn(type);
        assert.ok(animal.mesh.children.length > 0, type);
        for (let i = 0; i < 180; i++) {
            state.world.step(1 / 60);
            entities.updateDogs(1 / 60);
        }
        assert.notEqual(animal.state, 'falling', type);
        assert.ok(Number.isFinite(animal.body.position.y), type);
        assert.ok(animal.body.position.y >= animal.heightOffset * 2.5 - 2, type);
    }
});

test('soft friends squash while the turtle spins and restored jumpers use their own movement', () => {
    for (const type of ['sheep', 'pig', 'snorlax', 'ditto']) {
        entities.clearAllAnimals();
        const animal = standing(type);
        entities.triggerClickAction(animal);
        assert.equal(animal.clickActionType, 'squash', type);
        entities.updateDogs(0.2);
        assert.ok(animal.mesh.scale.x > animal.baseScale.x && animal.mesh.scale.y < animal.baseScale.y, type);
    }
    entities.clearAllAnimals();
    const turtle = standing('turtle');
    entities.triggerClickAction(turtle);
    assert.equal(turtle.clickActionType, 'spin');
    entities.updateDogs(0.2);
    assert.equal(turtle.body.velocity.z, 0, 'shell spin does not launch the turtle forward');
    for (const type of ['kangaroo', 'baby-dragon']) assert.equal(standing(type).animGroup, 'HOP');
});
test('ground queries respect start height and explicit fallback', () => {
    block(0, 25, 0);
    assert.ok(Math.abs(entities.getGroundHeightBelow(0, 49, 0)) < 1e-8);
    assert.equal(entities.getGroundHeightBelow(0, 51, 0), 50);
    assert.equal(entities.getGroundHeightBelow(3000, 100, 3000, 123), 123);
    assert.equal(entities.getGroundHeightBelow(3000, 100, 3000), 0);
});
test('spawning over a tall structure starts above its roof and synchronizes mesh', () => {
    block(0, 775, 0);
    const random = Math.random;
    Math.random = () => 0.5;
    let animal;
    try { animal = spawn('dog'); } finally { Math.random = random; }
    assert.ok(animal.body.position.y > 800 + animal.heightOffset * 2.5);
    assert.equal(animal.mesh.position.y, animal.body.position.y - animal.heightOffset * 2.5);
});
test('SNEAK dash survives subsequent AI updates', () => {
    const animal = standing('snake');
    entities.triggerClickAction(animal);
    entities.updateDogs(1 / 60);
    assert.equal(animal.body.velocity.z, 700);
    entities.updateDogs(1 / 60);
    assert.equal(animal.body.velocity.z, 700);
});
test('held animals keep their physics body aligned and cancel the old climb', () => {
    const animal = standing('snake');
    animal.grabbed = true;
    animal.isClimbing = true;
    animal.mesh.position.set(100, 300, 200);
    for (let i = 0; i < 180; i++) {
        state.world.step(1 / 60);
        entities.updateDogs(1 / 60);
    }
    assert.deepEqual(animal.body.position.toArray(), [100, 300 + animal.heightOffset * 2.5, 200]);
    assert.equal(animal.isClimbing, false);
});
test('all model types can eat food on the ground and have no buried parts', () => {
    for (const type of entities.GROUP_ANIMALS.all) {
        entities.clearAllAnimals();
        foods.length = 0;
        const animal = standing(type);
        const bounds = new THREE.Box3().setFromObject(animal.mesh);
        assert.ok(bounds.min.y >= -1e-8, type);
        const food = { position: new THREE.Vector3(30, 0, 0), eaten: false, consumeTimer: -1, falling: false };
        foods.push(food);
        entities.updateDogs(1 / 60);
        assert.equal(food.eaten, true, type);
        assert.equal(animal.isEating, true, type);
    }
});
test('fleeing animals remain within board boundaries', () => {
    const prey = standing('dog', 920, 0);
    standing('lion', 700, 0);
    entities.updateDogs(1 / 60);
    assert.equal(prey.body.position.x, 900);
    assert.ok(prey.body.velocity.x <= 0);
});
test('animals cannot consume nearby food through a blocking wall', () => {
    const animal = standing('dog');
    block(50, 25, 0); block(50, 75, 0);
    const food = { position: new THREE.Vector3(85, 0, 0), eaten: false, consumeTimer: -1, falling: false };
    foods.push(food);
    entities.updateDogs(1 / 60);
    assert.equal(food.eaten, false);
    assert.equal(animal.isEating, false);
});

test('balloon recipes ignore reachable food while drifting slowly above nearby snacks', () => {
    for (const recipe of [['balloon'], ['balloon', 'rainbow'], ['jelly', 'balloon']]) {
        entities.clearAllAnimals();
        const animal = standing('dog');
        const pursued = spawnFood(new THREE.Vector3(300, 0, 0), []);
        entities.updateDogs(1 / 60);
        assert.equal(animal.state, 'walking');
        assert.ok(animal.body.velocity.x > 0, 'ordinary animal first pursues the placed food');
        animal.mesh.rotation.y = 0;
        applySnack(animal, recipe);
        assert.equal(animal.state, 'idle', `${recipe}: reset the old pursuit immediately`);
        assert.equal(animal.timer, 0);
        animal.body.velocity.set(0, 0, 0);
        animal.magicEffect.floatVelocity.set(0, 0, 0);
        const food = spawnFood(new THREE.Vector3(30, 0, 0), []);
        animal.state = 'idle'; animal.timer = 1000;
        entities.updateDogs(1 / 60);
        assert.equal(food.eaten, false, `${recipe}: floating must not auto-eat during takeoff`);
        assert.equal(animal.isEating, false);

        animal.body.position.set(-200, animal.heightOffset * 2.5 + 160, 0);
        animal.body.velocity.set(0, 0, 0);
        animal.mesh.position.set(-200, 160, 0);
        animal.state = 'walking'; animal.timer = 1000; animal.targetDir.set(0, 0, 1);
        animal.speed = 300;
        for (let i = 0; i < 180; i++) {
            state.world.step(1 / 60);
            entities.updateDogs(1 / 60);
            updateMagicEffects(entities.animals, 1 / 60);
            assert.ok(Math.abs(animal.body.position.x + 200) < 30, `${recipe}: gentle wind never chases nearby food`);
            assert.ok(Math.hypot(animal.body.velocity.x, animal.body.velocity.z) <= 36 + 1e-8);
            assert.equal(animal.state, 'idle');
        }
        assert.ok(animal.body.position.z > 15 && animal.body.position.z < 100, `${recipe}: actual three-second breeze displacement`);
        assert.equal(food.eaten, false);
        assert.equal(pursued.eaten, false);
        clearAllFood();
    }
});

test('a floating animal passes above real food without reversing over it or eating', () => {
    const animal = standing('dog', 1, 0);
    const food = spawnFood(new THREE.Vector3(0, 0, 0), []);
    animal.body.position.y += 160; animal.mesh.position.y = 160;
    animal.mesh.rotation.y = Math.PI / 2;
    applySnack(animal, ['balloon']);
    animal.speed = 300; animal.state = 'walking'; animal.timer = 1000; animal.targetDir.set(1, 0, 0);
    let previousX = animal.body.position.x;
    for (let i = 0; i < 240; i++) {
        state.world.step(1 / 60);
        entities.updateDogs(1 / 60);
        updateMagicEffects(entities.animals, 1 / 60);
        assert.ok(animal.body.position.x >= previousX - 1e-6, `food must not reverse drift at frame ${i}`);
        assert.equal(animal.isEating, false);
        previousX = animal.body.position.x;
    }
    assert.ok(animal.body.position.x > 25 && animal.body.position.x < 120, 'gently drift past food without racing across the board');
    assert.equal(food.eaten, false);
    clearAllFood();
});

test('direct apple feeding and balloon expiry restore ordinary pursuit and automatic eating after landing', () => {
    for (const restore of ['apple', 'expiry']) {
        entities.clearAllAnimals();
        const animal = standing('dog');
        const food = spawnFood(new THREE.Vector3(70, 0, 0), []);
        applySnack(animal, ['balloon', 'rainbow']);
        animal.state = 'idle'; animal.timer = 1000;
        const floatingFrames = restore === 'expiry' ? 1200 : 180;
        for (let i = 0; i < floatingFrames; i++) {
            state.world.step(1 / 60);
            entities.updateDogs(1 / 60);
            updateMagicEffects(entities.animals, 1 / 60);
            assert.equal(food.eaten, false, `${restore}: ignore placed food while floating`);
        }
        assert.ok(animal.body.position.y > animal.heightOffset * 2.5 + 100);
        // The breeze can travel during twenty seconds; put this landing snack
        // within reach so the check measures restored feeding, not return time.
        food.position.set(animal.body.position.x + 70, 0, animal.body.position.z);
        food.mesh.position.copy(food.position);
        if (restore === 'apple') assert.equal(applySnack(animal, []), true);
        assert.equal(animal.magicEffect, undefined);
        entities.updateDogs(1 / 60);
        const foodDirection = food.position.clone().sub(animal.body.position).setY(0);
        assert.ok(animal.body.velocity.x * foodDirection.x + animal.body.velocity.z * foodDirection.z > 0, `${restore}: pursue food again immediately`);
        for (let i = 0; i < 180 && !food.eaten; i++) {
            state.world.step(1 / 60);
            entities.updateDogs(1 / 60);
            updateMagicEffects(entities.animals, 1 / 60);
        }
        assert.equal(food.eaten, true, `${restore}: eat again after descending within reach`);
        clearAllFood();
    }
});

test('automatically eating a balloon snack starts floating without retaining the eating state', () => {
    const animal = standing('dog');
    const snack = spawnFood(new THREE.Vector3(30, 0, 0), ['balloon']);
    entities.updateDogs(1 / 60);
    assert.equal(snack.eaten, true);
    assert.ok(animal.magicEffect?.ingredients.includes('balloon'));
    assert.equal(animal.isEating, false);
    assert.equal(animal.eatTimer, 0);
    clearAllFood();
});
test('HEAVY can break a tall wall while wandering', () => {
    const animal = standing('elephant');
    animal.speed = 200;
    animal.state = 'walking';
    animal.targetDir.set(1, 0, 0);
    block(100, 25, 0); block(100, 75, 0); block(100, 125, 0);
    entities.updateDogs(1 / 60);
    assert.equal(objects.length, 2);
    assert.ok(explodingBricks.length > 0);
});
test('HOP rejects walls wider than four blocks', () => {
    const animal = standing('rabbit');
    animal.speed = 300;
    animal.state = 'walking';
    animal.targetDir.set(1, 0, 0);
    for (let i = 0; i < 5; i++) block(100 + i * 50, 25, 0);
    entities.updateDogs(1 / 60);
    assert.equal(animal.body.velocity.y, 0);
});
test('HOP checks full wall stack height', () => {
    const animal = standing('rabbit');
    animal.speed = 300;
    animal.state = 'walking';
    animal.targetDir.set(1, 0, 0);
    for (let i = 0; i < 7; i++) block(100, 25 + i * 50, 0);
    entities.updateDogs(1 / 60);
    assert.equal(animal.body.velocity.y, 0);
});
test('removal disposes resources once and releases the grabbed reference', () => {
    const animal = standing('dog');
    animal.grabbed = true;
    entities.setGrabbedAnimal(animal);
    const geometries = new Set(animal.mesh.children.map(child => child.geometry));
    const materials = new Set(animal.mesh.children.map(child => child.material));
    let disposedGeometries = 0, disposedMaterials = 0;
    geometries.forEach(geometry => geometry.addEventListener('dispose', () => disposedGeometries++));
    materials.forEach(material => material.addEventListener('dispose', () => disposedMaterials++));
    entities.removeAnimalWithEffect(animal);
    assert.equal(entities.grabbedAnimal, null);
    assert.equal(state.world.bodies.length, 1);
    flush();
    assert.equal(animal.mesh.parent, null);
    assert.equal(disposedGeometries, geometries.size);
    assert.equal(disposedMaterials, materials.size);
});
test('bulk removal releases animal and smoke resources', () => {
    standing('dog'); standing('snake');
    entities.removeAllAnimalsWithEffect();
    const smoke = state.scene.children.filter(child => child.isMesh && child !== state.plane);
    const geometries = new Set(smoke.map(child => child.geometry));
    const materials = new Set(smoke.map(child => child.material));
    let disposedGeometries = 0, disposedMaterials = 0;
    geometries.forEach(geometry => geometry.addEventListener('dispose', () => disposedGeometries++));
    materials.forEach(material => material.addEventListener('dispose', () => disposedMaterials++));
    flush();
    assert.deepEqual(state.scene.children, [state.plane]);
    assert.equal(state.world.bodies.length, 1);
    assert.equal(disposedGeometries, geometries.size);
    assert.equal(disposedMaterials, materials.size);
});
reset();
console.log(JSON.stringify({ passed: tests.length, tests }, null, 2));
