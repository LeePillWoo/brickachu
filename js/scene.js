import * as THREE from 'three';
import { state, guiParams, objects, voxelSize, materials, explodingBricks } from './state.js';

export function getFullSnapshot() {
    const blockData = objects.filter(obj => obj !== state.plane).map(obj => ({
        pos: [obj.position.x, obj.position.y, obj.position.z],
        slot: obj.userData.slot
    }));
    return JSON.stringify({
        settings: guiParams,
        blocks: blockData
    });
}

export function pushHistory() {
    if (state.isRestoringHistory) return;
    const current = getFullSnapshot();
    const last = state.actionHistory[state.actionHistory.length - 1];
    if (current !== last) {
        state.actionHistory.push(current);
        state.actionRedoStack = [];
        if (state.actionHistory.length > 50) state.actionHistory.shift();
    }
}

export function undo() {
    if (state.actionHistory.length > 1) {
        const current = state.actionHistory.pop();
        state.actionRedoStack.push(current);
        const prev = state.actionHistory[state.actionHistory.length - 1];
        applyActionState(prev);
    }
}

export function redo() {
    if (state.actionRedoStack.length > 0) {
        const next = state.actionRedoStack.pop();
        state.actionHistory.push(next);
        applyActionState(next);
    }
}

export function placeVoxel(position, slotOverride = null, skipHistory = false) {
    const duplicate = objects.find(obj => obj !== state.plane && obj.position.equals(position));
    if (duplicate) return;

    const targetSlot = slotOverride || state.currentSlot;
    const material = materials[targetSlot];
    const voxel = new THREE.Mesh(state.cubeGeo, material);
    voxel.userData.slot = targetSlot;
    voxel.position.copy(position);
    voxel.castShadow = true;
    voxel.receiveShadow = true;
    state.scene.add(voxel);
    objects.push(voxel);

    if (!skipHistory) pushHistory();
}

export function removeVoxel(object) {
    if (object === state.plane) return;
    state.scene.remove(object);
    objects.splice(objects.indexOf(object), 1);
    if (!state.isDraggingRemove) pushHistory();
}

export function applyActionState(stateStr) {
    state.isRestoringHistory = true;
    const data = JSON.parse(stateStr);

    Object.assign(guiParams.block, data.settings.block);
    Object.assign(guiParams.board, data.settings.board);
    Object.assign(guiParams.light, data.settings.light);
    Object.assign(guiParams.ao, data.settings.ao);

    if (window.refreshGUI) window.refreshGUI();

    const placed = objects.filter(o => o !== state.plane);
    placed.forEach(o => {
        state.scene.remove(o);
        objects.splice(objects.indexOf(o), 1);
    });

    while (explodingBricks.length > 0) {
        const b = explodingBricks.pop();
        state.scene.remove(b);
    }

    data.blocks.forEach(b => {
        placeVoxel(new THREE.Vector3(...b.pos), b.slot, true);
    });

    state.isRestoringHistory = false;
}

export function explodeBricks() {
    const bricks = objects.filter(obj => obj !== state.plane);
    if (bricks.length === 0) return;

    pushHistory();

    const center = new THREE.Vector3();
    bricks.forEach(b => center.add(b.position));
    center.divideScalar(bricks.length);

    bricks.forEach(brick => {
        const dir = new THREE.Vector3().subVectors(brick.position, center).normalize();
        if (dir.lengthSq() === 0) {
            dir.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
        }

        const force = 5 + Math.random() * 10;
        brick.userData.velocity = dir.multiplyScalar(force);
        brick.userData.angularVelocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.2
        );
        brick.userData.startTime = performance.now();

        explodingBricks.push(brick);

        const index = objects.indexOf(brick);
        if (index > -1) objects.splice(index, 1);
    });
}
