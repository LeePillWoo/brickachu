import * as THREE from 'three';
import { state, objects, voxelSize, materials } from './state.js';
import { applyActionState, placeVoxel, removeVoxel } from './scene.js';
import { frameCamera } from './camera.js';
import { animals, setGrabbedAnimal, triggerClickAction, getGroundHeightAt, getGroundHeightBelow, snapAnimalToGround } from './entities.js';

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

    // 잡힌 동물 이동 시: 커서가 가리키는 면이 지붕 위(바닥)인지 지붕 아래(천장)인지 구분해 안착 높이 계산
    if (_grabbedAnimal) {
        const blockOnly = objects.filter(o => o !== state.plane);
        const hits = blockOnly.length > 0 ? state.raycaster.intersectObjects(blockOnly, false) : [];

        let groundY, posX, posZ;
        if (hits.length > 0) {
            const hit = hits[0];
            posX = hit.point.x;
            posZ = hit.point.z;
            const ny = hit.face ? hit.face.normal.y : 0;
            if (ny > 0.5) {
                groundY = hit.point.y;
            } else if (ny < -0.5) {
                groundY = getGroundHeightBelow(hit.point.x, hit.point.y - 0.1, hit.point.z);
            } else {
                groundY = hit.object.position.y + voxelSize / 2;
            }
        } else {
            _grabPlane.constant = 0;
            state.raycaster.ray.intersectPlane(_grabPlane, _grabIntersect);
            posX = _grabIntersect.x;
            posZ = _grabIntersect.z;
            groundY = getGroundHeightAt(_grabIntersect.x, _grabIntersect.z);
        }
        const hoverY = groundY + GRAB_HOVER_HEIGHT;
        _grabbedAnimal.mesh.position.set(posX, hoverY, posZ);
        if (_grabbedAnimal.body) {
            _grabbedAnimal.body.position.set(posX, hoverY, posZ);
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

    // 잡힘 동물 놓기: 다시 물리 적용 + 현재 층 최상단에 스냅
    if (_grabbedAnimal) {
        _grabbedAnimal.grabbed = false;
        _grabbedAnimal.state = 'falling';
        if (_grabbedAnimal.body) {
            _grabbedAnimal.body.wakeUp();
        }
        // 놓는 순간, 현재 위치의 가장 높은 블록 윗면 위에 정확히 안착시킴
        snapAnimalToGround(_grabbedAnimal);
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

        // ── 1) 동물 우선 클릭 처리 ──
        const allAnimalMeshes = animals.flatMap(a => [...a.mesh.children]);
        const animalHits = state.raycaster.intersectObjects(allAnimalMeshes, false);
        if (animalHits.length > 0) {
            const hitAnimal = animalHits[0].object.userData.animalRef;
            if (hitAnimal) {
                triggerClickAction(hitAnimal);
                // 동물 인터랙션이 발생하면 이 클릭으로는 블록 설치/제거를 하지 않음
                return;
            }
        }

        // ── 2) 동물이 아니면 기존 블록 조작 ──
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
