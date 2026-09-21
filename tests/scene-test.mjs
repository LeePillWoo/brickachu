import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, materials, explodingBricks, guiParams } from '../js/state.js';
import { foods, spawnFood } from '../js/food.js';
import { getFullSnapshot, pushHistory, placeVoxel, removeVoxel, undo, redo, explodeBricks, restoreBricks, explodeBlockHeavy, disposeExplodingBrick, applyActionState } from '../js/scene.js';
import { updatePreview, snapPreviewCamera, frameCamera } from '../js/camera.js';

state.scene = new THREE.Scene();
state.world = new CANNON.World();
state.plane = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000));
state.plane.rotateX(-Math.PI / 2);
state.scene.add(state.plane);
objects.push(state.plane);
state.previewScene = new THREE.Scene();
state.previewCamera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 10000);
state.previewRenderer = { getSize(out) { return out.set(200, 200); }, render() {} };
materials['preset-0'] = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.2 });
materials['custom-0'] = new THREE.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.3 });
const pos = (x, y = 25, z = 25) => new THREE.Vector3(x, y, z);
const count = () => objects.length - 1;
const coords = () => objects.slice(1).map(o => o.position.toArray());
const clear = () => {
    foods.length = 0;
    state.actionHistory.length = 0;
    state.actionRedoStack.length = 0;
    applyActionState(JSON.stringify({ settings: guiParams, blocks: [] }));
    pushHistory();
};
let passed = 0;
function check(name, fn) {
    clear();
    fn();
    console.log(`PASS ${name}`);
    passed++;
}

check('stale removal cannot delete the last live block or ground', () => {
    const a = placeVoxel(pos(25));
    const b = placeVoxel(pos(75));
    removeVoxel(a);
    removeVoxel(a);
    removeVoxel(null);
    assert.equal(count(), 1);
    assert.equal(objects[1], b);
    assert.equal(state.world.bodies.length, 1);
    assert.equal(state.previewObjects.length, 1);
});

check('new and restored blocks raycast at their real location before rendering', () => {
    placeVoxel(pos(425, 775, 25));
    const ray = new THREE.Raycaster(new THREE.Vector3(425, 1000, 25), new THREE.Vector3(0, -1, 0));
    assert.equal(ray.intersectObjects(objects.slice(1), false)[0]?.point.y, 800);
    applyActionState(getFullSnapshot());
    assert.equal(ray.intersectObjects(objects.slice(1), false)[0]?.point.y, 800);
});

check('explosion undo/redo and restore preserve the complete pre-explosion build', () => {
    placeVoxel(pos(25));
    placeVoxel(pos(75));
    const expected = coords();
    explodeBricks();
    assert.equal(count(), 0);
    assert.equal(state.previewObjects.length, 0);
    assert.equal(explodingBricks.length, 2);
    undo();
    assert.deepEqual(coords(), expected);
    assert.equal(explodingBricks.length, 0);
    assert.equal(state.world.bodies.length, 2);
    redo();
    assert.equal(count(), 0);
    placeVoxel(pos(125));
    restoreBricks();
    assert.deepEqual(coords(), expected);
    assert.equal(state.world.bodies.length, 2);
    assert.equal(state.previewObjects.length, 2);
    undo();
    assert.deepEqual(coords(), [[125, 25, 25]]);
});

check('snapshot restores every edited palette slot across undo/redo', () => {
    const original = materials['preset-0'].color.getHex();
    const originalCustom = materials['custom-0'].color.getHex();
    materials['preset-0'].color.setHex(0x123456);
    materials['custom-0'].color.setHex(0xabcdef);
    materials['custom-0'].roughness = 0.75;
    pushHistory();
    undo();
    assert.equal(materials['preset-0'].color.getHex(), original);
    assert.equal(materials['custom-0'].color.getHex(), originalCustom);
    redo();
    assert.equal(materials['preset-0'].color.getHex(), 0x123456);
    assert.equal(materials['custom-0'].color.getHex(), 0xabcdef);
    assert.equal(materials['custom-0'].roughness, 0.75);
});

check('removal, explosion, and history changes release unsupported food', () => {
    const block = placeVoxel(pos(25));
    const food = spawnFood(pos(25, 50));
    removeVoxel(block);
    assert.equal(food.falling, true);
    food.falling = false;
    placeVoxel(pos(25));
    const withBlock = getFullSnapshot();
    applyActionState(withBlock);
    assert.equal(food.falling, false);
    explodeBricks();
    assert.equal(food.falling, true);
});

check('HEAVY fragment resources are freed once and live block resources remain intact', () => {
    const block = placeVoxel(pos(25));
    let previewDisposals = 0;
    block.userData.previewMesh.material.addEventListener('dispose', () => previewDisposals++);
    explodeBlockHeavy(block);
    explodeBlockHeavy(block);
    assert.equal(explodingBricks.length, 8);
    assert.equal(previewDisposals, 1);
    const resources = explodingBricks[0].fragmentResources;
    let geometryDisposals = 0;
    let materialDisposals = 0;
    let cubeDisposals = 0;
    resources.geometry.addEventListener('dispose', () => geometryDisposals++);
    resources.material.addEventListener('dispose', () => materialDisposals++);
    const cubeListener = () => cubeDisposals++;
    state.cubeGeo.addEventListener('dispose', cubeListener);
    const first = explodingBricks[0];
    while (explodingBricks.length) disposeExplodingBrick(explodingBricks.pop());
    disposeExplodingBrick(first);
    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 1);
    assert.equal(cubeDisposals, 0);
    assert.equal(state.world.bodies.length, 0);
    state.cubeGeo.removeEventListener('dispose', cubeListener);
});

function assertFits(camera, blocks) {
    camera.updateMatrixWorld(true);
    for (const block of blocks) {
        const box = new THREE.Box3().setFromObject(block);
        for (const x of [box.min.x, box.max.x]) {
            for (const y of [box.min.y, box.max.y]) {
                for (const z of [box.min.z, box.max.z]) {
                    const projected = new THREE.Vector3(x, y, z).project(camera);
                    assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1,
                        `clipped corner ${projected.toArray()}`);
                }
            }
        }
    }
}

check('all preview directions fit a large displaced structure and reflect palette edits', () => {
    placeVoxel(pos(3025, 25, 25));
    placeVoxel(pos(5525, 1525, 575));
    for (const direction of ['iso-1', 'iso-2', 'iso-3', 'iso-4', 'top', 'bottom', 'front', 'back', 'left', 'right']) {
        snapPreviewCamera(direction);
        assertFits(state.previewCamera, state.previewObjects);
    }
    materials['preset-0'].color.setHex(0x00aaff);
    updatePreview();
    assert.equal(state.previewObjects[0].material.color.getHex(), 0x00aaff);
    placeVoxel(pos(9025, 25, 25));
    updatePreview();
    assertFits(state.previewCamera, state.previewObjects);
});

check('focus frames a large build in a portrait viewport and stops residual movement', () => {
    placeVoxel(pos(25));
    placeVoxel(pos(2025, 1025, 575));
    state.camera = new THREE.PerspectiveCamera(45, 0.35, 1, 10000);
    state.controls = { target: new THREE.Vector3(), update() {} };
    state.velocity.set(10, 20, 30);
    frameCamera();
    assertFits(state.camera, objects.slice(1));
    assert.equal(state.velocity.length(), 0);
});

check('failed parsing or GUI refresh does not leave history permanently disabled', () => {
    assert.throws(() => applyActionState('{ broken'));
    assert.equal(state.isRestoringHistory, false);
    window.refreshGUI = () => { throw new Error('test GUI failure'); };
    assert.throws(() => applyActionState(getFullSnapshot()));
    assert.equal(state.isRestoringHistory, false);
    delete window.refreshGUI;
});

console.log(`${passed} scene/camera regression scenarios passed`);
