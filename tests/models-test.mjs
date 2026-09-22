import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createSoftBoxGeometry, mergeStaticParts } from '../js/model-utils.js';
import { state } from '../js/state.js';
import { GROUP_ANIMALS, spawnDog, clearAllAnimals, updateDogs } from '../js/entities.js';
import { ANIMAL_CATEGORIES, ANIMAL_NAMES } from '../js/animal-catalog.js';

const checks = [];
function test(name, fn) { fn(); checks.push(name); console.log('PASS', name); }

test('soft parts retain dimensions, smooth corners and the real rounded silhouette', () => {
    const geometry = createSoftBoxGeometry(20, 24, 12, 3);
    geometry.computeBoundingBox();
    assert.deepEqual(geometry.boundingBox.getSize(new THREE.Vector3()).toArray(), [20, 24, 12]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 30), new THREE.Vector3(0, 0, -1));
    assert.ok(ray.intersectObject(mesh).length > 0);
    ray.ray.origin.set(9, 11, 30);
    assert.ok(ray.intersectObject(mesh).length > 0, 'old stair notch is filled by the rounded edge');
    ray.ray.origin.set(9.8, 11.8, 30);
    assert.equal(ray.intersectObject(mesh).length, 0);
    assert.ok([...geometry.attributes.normal.array].every(Number.isFinite));
    assert.ok([...geometry.attributes.normal.array].some(value => Math.abs(value) > 0.1 && Math.abs(value) < 0.9));
    geometry.dispose(); mesh.material.dispose();
    const patch = createSoftBoxGeometry(20, 24, 0.3, 3);
    patch.computeBoundingBox();
    assert.ok(patch.boundingBox.getSize(new THREE.Vector3()).distanceTo(new THREE.Vector3(20, 24, 0.3)) < 1e-5);
    const patchMesh = new THREE.Mesh(patch, new THREE.MeshBasicMaterial());
    assert.equal(ray.intersectObject(patchMesh).length, 0, 'thin belly patches keep rounded outlines');
    patch.dispose(); patchMesh.material.dispose();
});

test('batching preserves rotated silhouettes, picking and owned-resource cleanup', () => {
    const group = new THREE.Group(), material = new THREE.MeshBasicMaterial();
    const shared = new THREE.BoxGeometry(4, 8, 6);
    const a = new THREE.Mesh(shared, material), b = new THREE.Mesh(createSoftBoxGeometry(8, 12, 6), material);
    a.position.set(-7, 4, 0); a.rotation.z = 0.4;
    b.position.set(6, 7, 0); b.rotation.y = 0.3;
    a.userData.isAnimalPart = b.userData.isAnimalPart = true;
    group.add(a, b);
    const wheel = new THREE.Group(); wheel.add(new THREE.Mesh(shared, material)); group.add(wheel);
    const before = new THREE.Box3().setFromObject(group, true);
    const ray = new THREE.Raycaster(new THREE.Vector3(6, 7, 40), new THREE.Vector3(0, 0, -1));
    const distance = ray.intersectObject(group)[0].distance;
    let sharedDisposals = 0, bDisposals = 0;
    shared.addEventListener('dispose', () => sharedDisposals++);
    b.geometry.addEventListener('dispose', () => bDisposals++);
    mergeStaticParts(group);
    assert.equal(group.children.length, 2);
    assert.equal(group.children.find(child => child.isMesh).userData.isAnimalPart, true);
    const after = new THREE.Box3().setFromObject(group, true);
    assert.ok(before.min.distanceTo(after.min) < 1e-5 && before.max.distanceTo(after.max) < 1e-5);
    assert.ok(Math.abs(ray.intersectObject(group)[0].distance - distance) < 1e-5);
    assert.equal(sharedDisposals, 0, 'animated wheel still owns the shared geometry');
    assert.equal(bDisposals, 1);
    group.children.find(child => child.isMesh).geometry.dispose(); shared.dispose(); material.dispose();
});

test('all 26 animal models fit mobile draw budgets, retain picking and stand above ground', () => {
    state.scene = new THREE.Scene();
    state.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -1470, 0) });
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0); state.world.addBody(ground);
    const types = GROUP_ANIMALS.all;
    assert.equal(new Set(types).size, 26);
    const categorized = ANIMAL_CATEGORIES.filter(category => category.id !== 'all').flatMap(category => category.types);
    assert.equal(categorized.length, types.length, 'each friend belongs to exactly one browsing category');
    assert.deepEqual(new Set(categorized), new Set(types));
    assert.deepEqual(new Set(Object.keys(ANIMAL_NAMES)), new Set(types), 'all friends have visible Korean names');
    for (const group of Object.values(GROUP_ANIMALS)) {
        assert.ok(group.every(type => types.includes(type)), 'removed friends cannot appear in legacy spawn groups');
    }
    for (const type of types) {
        GROUP_ANIMALS.modelCheck = [type];
        const animal = spawnDog('modelCheck');
        assert.equal(animal.displayName, ANIMAL_NAMES[type]);
        assert.ok(animal.abilityName && animal.abilityDescription, `${type}: missing ability description`);
        animal.mesh.position.set(0, 0, 0); animal.mesh.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(animal.mesh);
        assert.ok(!bounds.isEmpty() && bounds.min.y >= -1e-5, type);
        assert.ok(animal.mesh.children.length <= 8, `${type}: too many material batches`);
        let triangles = 0;
        for (const part of animal.mesh.children) {
            assert.equal(part.userData.animalRef, animal, type);
            assert.ok([...part.geometry.attributes.position.array].every(Number.isFinite), type);
            triangles += (part.geometry.index?.count || part.geometry.attributes.position.count) / 3;
        }
        assert.ok(triangles < 5000, `${type}: excessive geometry`);
        const center = bounds.getCenter(new THREE.Vector3());
        const ray = new THREE.Raycaster(center.clone().add(new THREE.Vector3(0, 0, 500)), new THREE.Vector3(0, 0, -1));
        assert.ok(ray.intersectObject(animal.mesh).length > 0, `${type}: cannot pick torso`);
        for (let frame = 0; frame < 180; frame++) { state.world.step(1 / 60); updateDogs(1 / 60); }
        assert.notEqual(animal.state, 'falling', type);
        clearAllAnimals();
        assert.equal(state.world.bodies.length, 1, type);
        assert.equal(state.scene.children.length, 0, type);
    }
    delete GROUP_ANIMALS.modelCheck;
});

console.log(`${checks.length} model geometry checks passed`);
