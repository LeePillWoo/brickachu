import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, guiParams, objects, voxelSize, materials, explodingBricks } from './state.js';

// 블록 색상으로 MeshBasicMaterial을 만드는 헬퍼
function makePreviewMaterial(slot) {
    const srcMat = materials[slot];
    return new THREE.MeshBasicMaterial({ color: srcMat ? srcMat.color.clone() : new THREE.Color(0xffffff) });
}

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

    // 프리뷰 씬 동기화: MeshBasicMaterial로 동일 위치에 복사본 추가
    if (state.previewScene) {
        const previewMesh = new THREE.Mesh(state.cubeGeo, makePreviewMaterial(targetSlot));
        previewMesh.position.copy(position);
        voxel.userData.previewMesh = previewMesh;
        state.previewScene.add(previewMesh);
        state.previewObjects.push(previewMesh);
    }

    if (!skipHistory) pushHistory();
}

export function removeVoxel(object) {
    if (object === state.plane) return;
    state.scene.remove(object);
    objects.splice(objects.indexOf(object), 1);

    // 프리뷰 씬 동기화: 대응하는 프리뷰 메시 제거
    if (state.previewScene && object.userData.previewMesh) {
        state.previewScene.remove(object.userData.previewMesh);
        const idx = state.previewObjects.indexOf(object.userData.previewMesh);
        if (idx > -1) state.previewObjects.splice(idx, 1);
    }

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

    // 프리뷰 씬 초기화
    if (state.previewScene) {
        state.previewObjects.forEach(pm => state.previewScene.remove(pm));
        state.previewObjects.length = 0;
    }

    while (explodingBricks.length > 0) {
        const item = explodingBricks.pop();
        if (item.mesh) state.scene.remove(item.mesh);
        else state.scene.remove(item); // Fallback old

        if (item.body && state.world) {
            state.world.removeBody(item.body);
        }
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

    // Common box shape for all bricks
    const halfExtents = new CANNON.Vec3(voxelSize / 2, voxelSize / 2, voxelSize / 2);
    const boxShape = new CANNON.Box(halfExtents);
    const brickMaterial = new CANNON.Material();

    bricks.forEach(brick => {
        const body = new CANNON.Body({
            mass: 10, // Mass of individual block
            shape: boxShape,
            material: brickMaterial,
            position: new CANNON.Vec3(brick.position.x, brick.position.y, brick.position.z),
            quaternion: new CANNON.Quaternion(brick.quaternion.x, brick.quaternion.y, brick.quaternion.z, brick.quaternion.w)
        });

        // Add some angular velocity for a tumble effect
        body.angularVelocity.set(
            (Math.random() - 0.5) * 5,
            (Math.random() - 0.5) * 5,
            (Math.random() - 0.5) * 5
        );

        // Calculate outward impulse direction
        const dir = new THREE.Vector3().subVectors(brick.position, center).normalize();
        if (dir.lengthSq() === 0) {
            dir.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
        }

        const forceMagnitude = 2500 + Math.random() * 5000;
        const impulse = new CANNON.Vec3(dir.x * forceMagnitude, Math.abs(dir.y * forceMagnitude) + forceMagnitude * 0.5, dir.z * forceMagnitude);

        // Ensure it doesn't sleep immediately upon applying impulse
        body.wakeUp();
        body.applyImpulse(impulse, new CANNON.Vec3(0, 0, 0)); // Apply at center of mass

        if (state.world) {
            state.world.addBody(body);
        }

        explodingBricks.push({ mesh: brick, body: body, startTime: performance.now() });

        const index = objects.indexOf(brick);
        if (index > -1) objects.splice(index, 1);
    });
}
