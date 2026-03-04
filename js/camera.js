import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state, objects } from './state.js';

export function frameCamera() {
    const placedBlocks = objects.filter(o => o !== state.plane);
    if (placedBlocks.length === 0) return;
    const box = new THREE.Box3();
    placedBlocks.forEach(b => box.expandByObject(b));

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = Math.max(maxDim * 1.5, 300);

    state.camera.position.set(center.x + dist, center.y + dist * 0.8, center.z + dist);
    state.controls.target.copy(center);
    state.camera.lookAt(center);
    state.controls.update();
}

export function updatePreview() {
    if (!state.previewRenderer) return;
    state.rollOverMesh.visible = false;
    state.plane.visible = false;
    state.previewRenderer.render(state.scene, state.previewCamera);
    state.rollOverMesh.visible = true;
    state.plane.visible = true;
}

export function snapPreviewCamera(dir) {
    const structureObjects = objects.filter(obj => obj !== state.plane);
    const box = new THREE.Box3();

    if (structureObjects.length > 0) {
        structureObjects.forEach(obj => box.expandByObject(obj));
    } else {
        box.setFromObject(state.plane);
    }

    const center = new THREE.Vector3();
    box.getCenter(center);

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 200);
    const d = maxDim * 2.5;
    const iso = maxDim * 1.8;

    state.previewCamera.up.set(0, 1, 0);

    switch (dir) {
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
    updatePreview();
}
