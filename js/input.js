import * as THREE from 'three';
import { state, objects, voxelSize, materials } from './state.js';
import { applyActionState, placeVoxel, removeVoxel } from './scene.js';
import { frameCamera } from './camera.js';
import { animals, setGrabbedAnimal } from './entities.js';

// 동물 잡기 상태
let _grabbedAnimal = null;
let _grabHoldTimer = null;       // 꺼 누름 직전 예약 타이머
const GRAB_HOLD_MS = 350;        // 구 누르는 시간 (ms)

// 마우스 위치 평면 투영 (y=const 평면으로 커서 방향 변환)
const _grabPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _grabIntersect = new THREE.Vector3();
const GRAB_HOVER_HEIGHT = 120; // 공중 부양 높이 (units)


export function onKeyDown(event) {
    const key = event.key.toLowerCase();
    if (state.keys.hasOwnProperty(key)) state.keys[key] = true;
    if (event.code === 'KeyF') frameCamera();
    if (event.code === 'Escape') cancelDragBuild();

    if (event.ctrlKey) {
        if (key === 'z') {
            event.preventDefault();
            import('./scene.js').then(m => m.undo());
        }
        if (key === 'y') {
            event.preventDefault();
            import('./scene.js').then(m => m.redo());
        }
    }

    if (state.isDraggingBuild) {
        if (event.code === 'KeyE') { state.verticalBuildOffset++; updatePreviewPath(state.rollOverMesh.position); }
        if (event.code === 'KeyQ') { state.verticalBuildOffset--; updatePreviewPath(state.rollOverMesh.position); }
    }
}

export function onKeyUp(event) {
    const key = event.key.toLowerCase();
    if (state.keys.hasOwnProperty(key)) state.keys[key] = false;
}

export function onWindowResize() {
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(window.innerWidth, window.innerHeight);
}

export function onPointerMove(event) {
    state.pointer.set((event.clientX / window.innerWidth) * 2 - 1, - (event.clientY / window.innerHeight) * 2 + 1);
    state.raycaster.setFromCamera(state.pointer, state.camera);

    // 잡힌 동물 이동 시 코드 (grab 중에는 블록 조작 안 됨)
    if (_grabbedAnimal) {
        _grabPlane.constant = -GRAB_HOVER_HEIGHT;
        state.raycaster.ray.intersectPlane(_grabPlane, _grabIntersect);
        _grabbedAnimal.mesh.position.set(_grabIntersect.x, GRAB_HOVER_HEIGHT, _grabIntersect.z);
        if (_grabbedAnimal.body) {
            _grabbedAnimal.body.position.set(_grabIntersect.x, GRAB_HOVER_HEIGHT, _grabIntersect.z);
            _grabbedAnimal.body.velocity.set(0, 0, 0);
        }
        return;
    }

    const intersects = state.raycaster.intersectObjects(objects, false);

    if (intersects.length > 0) {
        const intersect = intersects[0];

        if (state.isAddMode) {
            const pos = intersect.point.clone().add(intersect.face.normal);
            pos.divideScalar(voxelSize).floor().multiplyScalar(voxelSize).addScalar(voxelSize / 2);

            const isColliding = objects.some(obj => obj !== state.plane && obj.position.distanceToSquared(pos) < 1);
            if (isColliding) {
                state.targetGuideOpacity = 0;
            } else {
                state.rollOverMaterial.color.set(0x00ff00);
                state.targetGuideOpacity = 0.5;
                state.rollOverMesh.position.copy(pos);
            }

            if (state.isDraggingBuild) {
                updatePreviewPath(state.rollOverMesh.position);
            }
        } else {
            if (intersect.object !== state.plane) {
                state.rollOverMaterial.color.set(0xff0000);
                state.targetGuideOpacity = 0.5;
                state.rollOverMesh.position.copy(intersect.object.position);

                if (state.isDraggingRemove) {
                    removeVoxel(intersect.object);
                }
            } else {
                state.targetGuideOpacity = 0;
            }
        }
    } else {
        state.targetGuideOpacity = 0;
    }
}

export function onPointerDown(event) {
    if (event.target.closest('#ui-layer') && !event.target.closest('#instructions') && !event.target.closest('#palette-popup')) {
        return;
    }

    const isSmallScreen = window.innerWidth < 768;
    state.downPointerPos.set(event.clientX, event.clientY);
    state.pointerDownTime = performance.now();

    if (event.button === 0 && !event.target.closest('#ui-layer')) {
        state.pointer.set((event.clientX / window.innerWidth) * 2 - 1, - (event.clientY / window.innerHeight) * 2 + 1);
        state.raycaster.setFromCamera(state.pointer, state.camera);

        // 동물 잡기: 동물 파트에 레이쾐스팅, GRAB_HOLD_MS 후 잡기 시작
        const allAnimalMeshes = animals.flatMap(a => [...a.mesh.children]);
        const animalHits = state.raycaster.intersectObjects(allAnimalMeshes, false);
        if (animalHits.length > 0) {
            const hitAnimal = animalHits[0].object.userData.animalRef;
            if (hitAnimal) {
                _grabHoldTimer = setTimeout(() => {
                    _grabbedAnimal = hitAnimal;
                    _grabbedAnimal.grabbed = true;
                    setGrabbedAnimal(_grabbedAnimal);
                    // 블록 드래그 취소
                    state.isDraggingBuild = false;
                    state.isDraggingRemove = false;
                }, GRAB_HOLD_MS);
                return; // 동물 누름 중에는 블록 조작 안 시작
            }
        }

        const intersects = state.raycaster.intersectObjects(objects, false);

        if (state.isAddMode) {
            if (intersects.length > 0) {
                if (!isSmallScreen) {
                    state.isDraggingBuild = true;
                    state.verticalBuildOffset = 0;
                    const intersect = intersects[0];
                    state.dragStartPos.copy(intersect.point).add(intersect.face.normal);
                    state.dragStartPos.divideScalar(voxelSize).floor().multiplyScalar(voxelSize).addScalar(voxelSize / 2);
                    addPreviewBlock(state.dragStartPos);
                }
            }
        } else {
            if (intersects.length > 0 && intersects[0].object !== state.plane) {
                if (!isSmallScreen) {
                    state.isDraggingRemove = true;
                }
            }
        }
    }
}

export function onPointerUp(event) {
    // 잡기 예약 타이머 취소 (꺼 누르지 않고 떼면 그냥 클릭으로 처리)
    if (_grabHoldTimer) {
        clearTimeout(_grabHoldTimer);
        _grabHoldTimer = null;
    }

    // 잡힘 동물 놓기: 다시 물리 적용
    if (_grabbedAnimal) {
        _grabbedAnimal.grabbed = false;
        _grabbedAnimal.state = 'falling';
        if (_grabbedAnimal.body) {
            _grabbedAnimal.body.wakeUp();
        }
        setGrabbedAnimal(null);
        _grabbedAnimal = null;
        return; // 놓을 때는 블록 조작 불필요
    }

    if (event.button === 0) {
        if (state.previewGroup.children.length > 0) {
            state.previewGroup.children.forEach(child => {
                placeVoxel(child.position, state.currentSlot, true);
            });
            while (state.previewGroup.children.length > 0) {
                state.previewGroup.remove(state.previewGroup.children[0]);
            }
            import('./scene.js').then(m => m.pushHistory());
        }
        if (state.isDraggingRemove) {
            import('./scene.js').then(m => m.pushHistory());
        }
        state.isDraggingBuild = false;
        state.isDraggingRemove = false;
        state.targetGuideOpacity = 0;
        state.rollOverMaterial.opacity = 0;
    }

    const dist = state.downPointerPos.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
    const timeDelta = performance.now() - state.pointerDownTime;

    if (dist < 10 && timeDelta < 500 && !event.target.closest('#ui-layer')) {
        state.pointer.set((event.clientX / window.innerWidth) * 2 - 1, - (event.clientY / window.innerHeight) * 2 + 1);
        state.raycaster.setFromCamera(state.pointer, state.camera);
        const intersects = state.raycaster.intersectObjects(objects, false);

        if (intersects.length > 0) {
            const intersect = intersects[0];
            if (state.isAddMode) {
                const pos = intersect.point.clone().add(intersect.face.normal);
                pos.divideScalar(voxelSize).floor().multiplyScalar(voxelSize).addScalar(voxelSize / 2);
                placeVoxel(pos);
            } else {
                if (intersect.object !== state.plane) {
                    removeVoxel(intersect.object);
                }
            }
            state.targetGuideOpacity = 0;
            state.rollOverMaterial.opacity = 0;
        }
    }
}

function cancelDragBuild() {
    if (state.isDraggingBuild) {
        state.isDraggingBuild = false;
        state.verticalBuildOffset = 0;
        while (state.previewGroup.children.length > 0) {
            state.previewGroup.remove(state.previewGroup.children[0]);
        }
    }
}

function updatePreviewPath(currentPos) {
    while (state.previewGroup.children.length > 0) {
        state.previewGroup.remove(state.previewGroup.children[0]);
    }

    const dx = Math.round((currentPos.x - state.dragStartPos.x) / voxelSize);
    const dz = Math.round((currentPos.z - state.dragStartPos.z) / voxelSize);
    const dy = state.verticalBuildOffset;

    let targetDx = dx, targetDz = dz;
    const absX = Math.abs(dx);
    const absZ = Math.abs(dz);

    if (absX > absZ * 1.5) { targetDz = 0; }
    else if (absZ > absX * 1.5) { targetDx = 0; }
    else {
        const diag = Math.max(absX, absZ);
        targetDx = dx > 0 ? diag : -diag;
        targetDz = dz > 0 ? diag : -diag;
    }

    const steps = Math.max(Math.abs(targetDx), Math.abs(dy), Math.abs(targetDz));
    if (steps === 0) {
        addPreviewBlock(state.dragStartPos);
        return;
    }

    for (let i = 0; i <= steps; i++) {
        const stepX = Math.round((targetDx / steps) * i);
        const stepY = Math.round((dy / steps) * i);
        const stepZ = Math.round((targetDz / steps) * i);

        const pos = state.dragStartPos.clone().add(new THREE.Vector3(
            stepX * voxelSize,
            stepY * voxelSize,
            stepZ * voxelSize
        ));
        addPreviewBlock(pos);
    }
}

function addPreviewBlock(pos) {
    const mesh = new THREE.Mesh(state.cubeGeo, state.previewMaterial);
    mesh.position.copy(pos);
    state.previewGroup.add(mesh);
    state.previewMaterial.color.copy(materials[state.currentSlot].color);
}
