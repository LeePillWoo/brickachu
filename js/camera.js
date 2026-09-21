import * as THREE from 'three';
import { state, objects, materials, voxelSize } from './state.js';

let previewDirection = 'iso-1';
let previewNeedsFit = true;

export function invalidatePreview() {
    previewNeedsFit = true;
}

export function frameCamera() {
    const placedBlocks = objects.filter(o => o !== state.plane);
    if (placedBlocks.length === 0) return;
    const box = new THREE.Box3();
    placedBlocks.forEach(b => box.expandByObject(b));

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    const radius = size.length() / 2;
    const verticalFov = THREE.MathUtils.degToRad(state.camera.getEffectiveFOV());
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * state.camera.aspect);
    const dist = Math.max(radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.1, 300);
    const direction = new THREE.Vector3(1, 0.8, 1).normalize();
    state.camera.position.copy(center).addScaledVector(direction, dist);
    state.camera.far = Math.max(state.camera.far, dist + radius * 2);
    state.camera.updateProjectionMatrix();
    state.velocity.set(0, 0, 0);
    state.controls.target.copy(center);
    state.camera.lookAt(center);
    state.controls.update();
}

export function updatePreview() {
    if (!state.previewRenderer || !state.previewScene || !state.previewCamera) return;
    if (previewNeedsFit) fitPreviewCamera();
    for (const mesh of state.previewObjects) {
        const material = materials[mesh.userData.slot];
        if (material) mesh.material.color.copy(material.color);
    }
    // 프리뷰 전용 씬을 렌더링 (동물/조명/보조 오브젝트 없이 블록만 표시)
    state.previewRenderer.render(state.previewScene, state.previewCamera);
}

export function snapPreviewCamera(dir) {
    if (!['iso-1', 'iso-2', 'iso-3', 'iso-4', 'top', 'bottom', 'front', 'back', 'left', 'right'].includes(dir)) return;
    previewDirection = dir;
    previewNeedsFit = true;
    updatePreview();
}

function fitPreviewCamera() {
    const box = new THREE.Box3();

    if (state.previewObjects && state.previewObjects.length > 0) {
        state.previewObjects.forEach(obj => box.expandByObject(obj));
    } else {
        // 블록이 없으면 원점 기준 기본 영역 설정
        box.set(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
    }

    const center = new THREE.Vector3();
    box.getCenter(center);

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 200);
    const d = maxDim * 2.5;
    const iso = maxDim * 1.8;

    state.previewCamera.up.set(0, 1, 0);

    switch (previewDirection) {
        case 'iso-1': state.previewCamera.position.set(center.x + iso, center.y + iso, center.z + iso); break;
        case 'iso-2': state.previewCamera.position.set(center.x - iso, center.y + iso, center.z + iso); break;
        case 'iso-3': state.previewCamera.position.set(center.x - iso, center.y + iso, center.z - iso); break;
        case 'iso-4': state.previewCamera.position.set(center.x + iso, center.y + iso, center.z - iso); break;
        case 'top':
            state.previewCamera.position.set(center.x, center.y + d, center.z);
            state.previewCamera.up.set(0, 0, -1);
            break;
        case 'bottom':
            state.previewCamera.position.set(center.x, center.y - d, center.z);
            state.previewCamera.up.set(0, 0, 1);
            break;
        case 'front': state.previewCamera.position.set(center.x, center.y, center.z + d); break;
        case 'back': state.previewCamera.position.set(center.x, center.y, center.z - d); break;
        case 'left': state.previewCamera.position.set(center.x - d, center.y, center.z); break;
        case 'right': state.previewCamera.position.set(center.x + d, center.y, center.z); break;
    }

    state.previewCamera.lookAt(center);
    state.previewCamera.updateMatrixWorld(true);

    // 직교 카메라는 거리를 바꿔도 줌이 바뀌지 않으므로 화면에 투영한 경계로 맞춘다.
    let halfWidth = 0;
    let halfHeight = 0;
    const corner = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
                corner.set(x, y, z).applyMatrix4(state.previewCamera.matrixWorldInverse);
                halfWidth = Math.max(halfWidth, Math.abs(corner.x));
                halfHeight = Math.max(halfHeight, Math.abs(corner.y));
            }
        }
    }
    const renderSize = state.previewRenderer.getSize(new THREE.Vector2());
    const aspect = renderSize.x / Math.max(renderSize.y, 1);
    halfHeight = Math.max(halfHeight, halfWidth / aspect, voxelSize * 1.5) * 1.15;
    state.previewCamera.left = -halfHeight * aspect;
    state.previewCamera.right = halfHeight * aspect;
    state.previewCamera.top = halfHeight;
    state.previewCamera.bottom = -halfHeight;
    state.previewCamera.far = Math.max(10000, d * 3);
    state.previewCamera.updateProjectionMatrix();
    previewNeedsFit = false;
}

