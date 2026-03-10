import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, guiParams, objects, voxelSize, materials, explodingBricks } from './state.js';
import { foods, triggerFoodFall } from './food.js';
import { playSound } from './sound.js';

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

    // 블록에 정적 물리 바디 추가 → 동물이 블록 위에 서거나 부딪힘
    if (state.world) {
        const half = voxelSize / 2;
        const blockBody = new CANNON.Body({
            type: CANNON.Body.STATIC,
            shape: new CANNON.Box(new CANNON.Vec3(half, half, half)),
            material: state.groundMaterial || undefined
        });
        blockBody.position.set(position.x, position.y, position.z);
        state.world.addBody(blockBody);
        voxel.userData.physicsBody = blockBody;
    }

    // 프리뷰 씬 동기화: MeshBasicMaterial로 동일 위치에 복사본 추가
    if (state.previewScene) {
        const previewMesh = new THREE.Mesh(state.cubeGeo, makePreviewMaterial(targetSlot));
        previewMesh.position.copy(position);
        voxel.userData.previewMesh = previewMesh;
        state.previewScene.add(previewMesh);
        state.previewObjects.push(previewMesh);
    }

    if (!skipHistory) pushHistory();
    playSound('block-place');
}

export function removeVoxel(object) {
    if (object === state.plane) return;
    state.scene.remove(object);
    objects.splice(objects.indexOf(object), 1);

    // 블록 물리 바디 제거
    if (object.userData.physicsBody && state.world) {
        state.world.removeBody(object.userData.physicsBody);
        object.userData.physicsBody = null;
    }

    // 프리뷰 씬 동기화: 대응하는 프리뷰 메시 제거
    if (state.previewScene && object.userData.previewMesh) {
        state.previewScene.remove(object.userData.previewMesh);
        const idx = state.previewObjects.indexOf(object.userData.previewMesh);
        if (idx > -1) state.previewObjects.splice(idx, 1);
    }

    if (!state.isDraggingRemove) pushHistory();
    playSound('block-remove');
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
        // undo/redo 시 블록 물리 바디도 제거
        if (o.userData.physicsBody && state.world) {
            state.world.removeBody(o.userData.physicsBody);
            o.userData.physicsBody = null;
        }
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

// HEAVY 동물이 블록을 파괴할 때: 파편 8조각이 폭발하며 날아감
export function explodeBlockHeavy(block, hitDirection) {
    if (!block || block === state.plane) return;

    const blockPos = block.position.clone();
    const blockColor = block.material ? block.material.color.getHex() : 0xffffff;
    const blockRoughness = (block.material && block.material.roughness != null) ? block.material.roughness : 0.5;

    // 원본 블록 제거 (물리 바디 포함)
    state.scene.remove(block);
    const blockIdx = objects.indexOf(block);
    if (blockIdx > -1) objects.splice(blockIdx, 1);
    if (block.userData.physicsBody && state.world) {
        state.world.removeBody(block.userData.physicsBody);
        block.userData.physicsBody = null;
    }
    if (state.previewScene && block.userData.previewMesh) {
        state.previewScene.remove(block.userData.previewMesh);
        const idx = state.previewObjects.indexOf(block.userData.previewMesh);
        if (idx > -1) state.previewObjects.splice(idx, 1);
    }
    pushHistory();

    // ── 파괴된 블록 위 사과 낙하 트리거 ──
    const blockTopY = blockPos.y + voxelSize * 0.5;
    for (const food of foods) {
        if (food.eaten || food.consumeTimer > 0 || food.falling) continue;
        const dx = Math.abs(food.position.x - blockPos.x);
        const dz = Math.abs(food.position.z - blockPos.z);
        const dy = Math.abs(food.position.y - blockTopY);
        if (dx <= voxelSize * 0.65 && dz <= voxelSize * 0.65 && dy <= voxelSize * 0.3) {
            triggerFoodFall(food, 100 + Math.random() * 160);
        }
    }

    // 파편 8조각 (2×2×2 분할)
    const fragSize = voxelSize * 0.46;
    const halfF = fragSize / 2;
    const spread = voxelSize * 0.55;
    const fragGeo = new THREE.BoxGeometry(fragSize, fragSize, fragSize);
    const fragMat = new THREE.MeshPhysicalMaterial({ color: blockColor, roughness: blockRoughness });

    const offsets = [
        [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
        [-1, -1,  1], [1, -1,  1], [-1, 1,  1], [1, 1,  1],
    ];

    offsets.forEach(([ox, oy, oz]) => {
        const fragMesh = new THREE.Mesh(fragGeo, fragMat);
        fragMesh.castShadow = true;
        const sx = blockPos.x + ox * spread;
        const sy = blockPos.y + oy * spread;
        const sz = blockPos.z + oz * spread;
        fragMesh.position.set(sx, sy, sz);
        state.scene.add(fragMesh);

        const fragBody = new CANNON.Body({
            mass: 2,
            shape: new CANNON.Box(new CANNON.Vec3(halfF, halfF, halfF)),
            position: new CANNON.Vec3(sx, sy, sz),
            material: state.groundMaterial || new CANNON.Material(),
            linearDamping: 0.12,
        });

        // 폭발 속도: 방사형 확산 + 히트 방향 편향 + 위쪽 힘
        const angle = Math.random() * Math.PI * 2;
        const radial = 350 + Math.random() * 450;
        const dirBias = hitDirection ? 550 : 0;
        fragBody.velocity.set(
            Math.sin(angle) * radial + (hitDirection ? hitDirection.x * dirBias : 0),
            480 + Math.random() * 380,
            Math.cos(angle) * radial + (hitDirection ? hitDirection.z * dirBias : 0)
        );
        fragBody.angularVelocity.set(
            (Math.random() - 0.5) * 28,
            (Math.random() - 0.5) * 28,
            (Math.random() - 0.5) * 28
        );

        if (state.world) state.world.addBody(fragBody);

        explodingBricks.push({
            mesh: fragMesh,
            body: fragBody,
            startTime: performance.now(),
            maxLife: 2.5,   // 커스텀 수명 (초)
            fadeLife: 1.8,  // 이 시점부터 축소 페이드
        });
    });
}

export function explodeBricks() {
    const bricks = objects.filter(obj => obj !== state.plane);
    if (bricks.length === 0) return;

    pushHistory();
    playSound('explode');

    const center = new THREE.Vector3();
    bricks.forEach(b => center.add(b.position));
    center.divideScalar(bricks.length);

    // Common box shape for all bricks
    const halfExtents = new CANNON.Vec3(voxelSize / 2, voxelSize / 2, voxelSize / 2);
    const boxShape = new CANNON.Box(halfExtents);
    const brickMaterial = new CANNON.Material();

    bricks.forEach(brick => {
        // 폭발 전 정적 물리 바디 먼저 제거
        if (brick.userData.physicsBody && state.world) {
            state.world.removeBody(brick.userData.physicsBody);
            brick.userData.physicsBody = null;
        }

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
