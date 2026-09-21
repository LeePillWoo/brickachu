import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, guiParams, objects, voxelSize, materials, explodingBricks } from './state.js';
import { foods, triggerFoodFall } from './food.js';
import { playSound } from './sound.js';
import { invalidatePreview } from './camera.js';
import { snapshotLivingAnimals, reconcileLivingAnimals } from './living.js';
import { animals, detachAnimalsForExplosion, disposeAnimalMesh } from './entities.js';
import { clearTrain } from './train.js';

// 블록 색상으로 MeshBasicMaterial을 만드는 헬퍼
function makePreviewMaterial(slot) {
    const srcMat = materials[slot];
    return new THREE.MeshBasicMaterial({ color: srcMat ? srcMat.color.clone() : new THREE.Color(0xffffff) });
}

function removePreviewMesh(voxel) {
    const previewMesh = voxel.userData.previewMesh;
    if (!previewMesh) return;
    if (state.previewScene) state.previewScene.remove(previewMesh);
    const index = state.previewObjects.indexOf(previewMesh);
    if (index !== -1) state.previewObjects.splice(index, 1);
    previewMesh.material.dispose();
    voxel.userData.previewMesh = null;
    invalidatePreview();
}

function triggerUnsupportedFoodFall(bounceVelocity = 0) {
    const half = voxelSize / 2 + 0.001;
    for (const food of foods) {
        if (food.eaten || food.consumeTimer > 0 || food.falling || food.position.y <= 0.001) continue;
        const supported = objects.some(block => block !== state.plane
            && Math.abs(block.position.x - food.position.x) <= half
            && Math.abs(block.position.z - food.position.z) <= half
            && Math.abs(block.position.y + voxelSize / 2 - food.position.y) <= 0.001);
        if (!supported) triggerFoodFall(food, bounceVelocity);
    }
}

function detachVoxel(voxel) {
    const index = objects.indexOf(voxel);
    if (!voxel || voxel === state.plane || index === -1) return false;
    state.scene.remove(voxel);
    objects.splice(index, 1);
    if (voxel.userData.physicsBody && state.world) {
        state.world.removeBody(voxel.userData.physicsBody);
        voxel.userData.physicsBody = null;
    }
    removePreviewMesh(voxel);
    return true;
}

// A whole connected build becomes one friend and one history action.
export function detachVoxelsForLiving(voxels) {
    voxels.forEach(detachVoxel);
    triggerUnsupportedFoodFall();
}

// 일반 블록의 geometry/material은 팔레트와 공유하지만 HEAVY 파편은 소유 리소스다.
export function disposeExplodingBrick(item) {
    if (!item || item.disposed) return;
    item.disposed = true;
    const mesh = item.mesh || item;
    state.scene.remove(mesh);
    if (mesh.userData) removePreviewMesh(mesh);
    if (item.body && state.world) state.world.removeBody(item.body);
    const resources = item.fragmentResources;
    if (resources && --resources.references === 0) {
        (resources.geometries || [resources.geometry]).forEach(geometry => geometry.dispose());
        (resources.materials || [resources.material]).forEach(material => material.dispose());
    }
    if (item.ownsMeshResources) disposeAnimalMesh(mesh);
}

export function getFullSnapshot() {
    const blockData = objects.filter(obj => obj !== state.plane).map(obj => ({
        pos: [obj.position.x, obj.position.y, obj.position.z],
        slot: obj.userData.slot
    }));
    return JSON.stringify({
        settings: guiParams,
        materials: Object.fromEntries(Object.entries(materials).map(([slot, material]) => [slot, {
            color: material.color.getHex(),
            roughness: material.roughness
        }])),
        blocks: blockData,
        living: snapshotLivingAnimals()
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

    const targetSlot = slotOverride ?? state.currentSlot;
    const material = materials[targetSlot];
    const voxel = new THREE.Mesh(state.cubeGeo, material);
    voxel.userData.slot = targetSlot;
    voxel.position.copy(position);
    voxel.castShadow = true;
    voxel.receiveShadow = true;
    state.scene.add(voxel);
    // AI 지면 검사와 스폰은 다음 렌더보다 먼저 실행될 수 있다.
    voxel.updateMatrixWorld(true);
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
        previewMesh.userData.slot = targetSlot;
        previewMesh.position.copy(position);
        voxel.userData.previewMesh = previewMesh;
        state.previewScene.add(previewMesh);
        state.previewObjects.push(previewMesh);
        invalidatePreview();
    }

    if (!skipHistory) pushHistory();
    if (!state.isRestoringHistory) playSound('block-place');
    return voxel;
}

export function removeVoxel(object) {
    if (!detachVoxel(object)) return;
    triggerUnsupportedFoodFall();
    if (!state.isDraggingRemove) pushHistory();
    playSound('block-remove');
}

export function applyActionState(stateStr) {
    const data = JSON.parse(stateStr);
    state.isRestoringHistory = true;
    try {
        Object.assign(guiParams.block, data.settings.block);
        Object.assign(guiParams.board, data.settings.board);
        Object.assign(guiParams.light, data.settings.light);
        Object.assign(guiParams.ao, data.settings.ao);

        for (const [slot, saved] of Object.entries(data.materials || {})) {
            if (!materials[slot]) continue;
            materials[slot].color.setHex(saved.color);
            materials[slot].roughness = saved.roughness;
        }
        if (window.refreshGUI) window.refreshGUI();

        objects.filter(o => o !== state.plane).forEach(detachVoxel);
        // 이전 폭발에서 남아 있을 수 있는 프리뷰도 함께 정리한다.
        state.previewObjects.forEach(mesh => {
            if (state.previewScene) state.previewScene.remove(mesh);
            mesh.material.dispose();
        });
        state.previewObjects.length = 0;

        while (explodingBricks.length > 0) {
            disposeExplodingBrick(explodingBricks.pop());
        }

        data.blocks.forEach(b => placeVoxel(new THREE.Vector3(...b.pos), b.slot, true));
        reconcileLivingAnimals(data.living || []);
        triggerUnsupportedFoodFall();
    } finally {
        state.isRestoringHistory = false;
    }
}

// HEAVY 동물이 블록을 파괴할 때: 파편 8조각이 폭발하며 날아감
export function explodeBlockHeavy(block, hitDirection) {
    if (!block || block === state.plane || !objects.includes(block)) return;

    const blockPos = block.position.clone();
    const blockColor = block.material ? block.material.color.getHex() : 0xffffff;
    const blockRoughness = (block.material && block.material.roughness != null) ? block.material.roughness : 0.5;

    // 원본 블록 제거 (물리 바디 포함)
    detachVoxel(block);
    pushHistory();

    // ── 파괴된 블록 위 사과 낙하 트리거 ──
    triggerUnsupportedFoodFall(100 + Math.random() * 160);

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
    const fragmentResources = { geometry: fragGeo, material: fragMat, references: offsets.length };

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
            fragmentResources,
        });
    });
}

export function explodeBricks() {
    const bricks = objects.filter(obj => obj !== state.plane);
    const hadTrain = Boolean(state.train);
    clearTrain();
    if (bricks.length === 0 && animals.length === 0) {
        if (hadTrain) playSound('explode');
        return;
    }

    state.preExplosionSnapshot = getFullSnapshot();
    pushHistory();
    playSound('explode');

    const parts = bricks.map(mesh => ({ mesh })).concat(detachAnimalsForExplosion());

    const center = new THREE.Vector3();
    parts.forEach(part => center.add(part.mesh.position));
    center.divideScalar(parts.length);

    // Common box shape for all bricks
    const halfExtents = new CANNON.Vec3(voxelSize / 2, voxelSize / 2, voxelSize / 2);
    const boxShape = new CANNON.Box(halfExtents);
    const brickMaterial = new CANNON.Material();

    parts.forEach(part => {
        const brick = part.mesh;
        removePreviewMesh(brick);
        // 폭발 전 정적 물리 바디 먼저 제거
        if (brick.userData.physicsBody && state.world) {
            state.world.removeBody(brick.userData.physicsBody);
            brick.userData.physicsBody = null;
        }

        const size = part.physicsSize || new THREE.Vector3(voxelSize, voxelSize, voxelSize).multiply(brick.scale);
        const shape = part.physicsSize || !brick.scale.equals(new THREE.Vector3(1, 1, 1))
            ? new CANNON.Box(new CANNON.Vec3(Math.max(0.5, Math.abs(size.x) / 2), Math.max(0.5, Math.abs(size.y) / 2), Math.max(0.5, Math.abs(size.z) / 2)))
            : boxShape;
        const body = new CANNON.Body({
            mass: 10, // Mass of individual block
            shape,
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

        explodingBricks.push({ ...part, body, baseScale: brick.scale.clone(), startTime: performance.now() });

        const index = objects.indexOf(brick);
        if (index > -1) objects.splice(index, 1);
    });
    triggerUnsupportedFoodFall();
    pushHistory();
}

export function restoreBricks() {
    if (!state.preExplosionSnapshot) return;
    pushHistory();
    applyActionState(state.preExplosionSnapshot);
    pushHistory();
}
