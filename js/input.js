import * as THREE from 'three';
import { state, objects, voxelSize, materials } from './state.js';
import { placeVoxel, removeVoxel, pushHistory, undo, redo } from './scene.js';
import { frameCamera } from './camera.js';
import { animals, setGrabbedAnimal, triggerClickAction, getGroundHeightAt, getGroundHeightBelow, snapAnimalToGround, removeAnimalWithEffect } from './entities.js';
import { foods, spawnFood, showFoodGhost, hideFoodGhost, removeFoodWithEffect } from './food.js';
import { collectConnectedBlocks, awakenBlocks } from './living.js';
import { applySnack } from './magic.js';
import { playSound } from './sound.js';
import { spawnTrain, clearTrain, beginTrainRoute, appendTrainRoutePoint, finishTrainRoute, cancelTrainRoute } from './train.js';

let activePointer = null;
let _grabbedAnimal = null;
let _grabHoldTimer = null;
let _grabGroundY = null;
let _controlsWereEnabled = true;
let _trainDrag = null;
const GRAB_HOLD_MS = 350;
const TAP_DISTANCE = 10;
const GRAB_HOVER_HEIGHT = 120;
const MAX_PATH_BLOCKS = 1000;
const _grabPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _grabIntersect = new THREE.Vector3();
const _trainPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _trainIntersect = new THREE.Vector3();
const _grabPickPointer = new THREE.Vector2();

function isInterface(target) {
    return !!target?.closest?.('#ui-layer, #palette-popup, .lil-gui, input, textarea, select, button, [contenteditable="true"]');
}

function isEditingText(target) {
    return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

function setPointerRay(event) {
    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    state.camera.updateMatrixWorld();
    state.scene.updateMatrixWorld(true);
    state.raycaster.setFromCamera(state.pointer, state.camera);
}

// 같은 레이의 가장 가까운 물체만 선택하여 벽 뒤 동물을 잡거나 지우지 않는다.
function getHit() {
    const hits = state.raycaster.intersectObjects([
        ...objects,
        ...(state.train?.mesh ? [state.train.mesh] : []),
        ...animals.map(a => a.mesh),
        ...foods.filter(f => !f.eaten && f.consumeTimer < 0).map(f => f.mesh)
    ], true);
    for (const hit of hits) {
        let object = hit.object;
        while (object) {
            if (object.userData.trainRef) return { ...hit, train: object.userData.trainRef };
            if (object.userData.animalRef) return { ...hit, animal: object.userData.animalRef };
            if (object.userData.foodRef) return { ...hit, food: object.userData.foodRef };
            object = object.parent;
        }
        if (objects.includes(hit.object)) return hit;
    }
    return null;
}

// Expand only the hand tool by CSS pixels. Every sample still raycasts the
// visible scene, so a nearby animal cannot be grabbed through a wall or train.
function getGrabHit(event, directHit) {
    if (directHit?.animal || (directHit && directHit.object !== state.plane)) return directHit;
    const rect = state.renderer.domElement.getBoundingClientRect();
    const radius = event.pointerType === 'touch' ? 18 : 8;
    _grabPickPointer.copy(state.pointer);
    try {
        for (const distance of [radius / 2, radius]) {
            for (let step = 0; step < 8; step++) {
                const angle = step * Math.PI / 4;
                const x = event.clientX + Math.cos(angle) * distance;
                const y = event.clientY + Math.sin(angle) * distance;
                if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
                state.pointer.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
                state.raycaster.setFromCamera(state.pointer, state.camera);
                const hit = getHit();
                if (hit?.animal) return hit;
            }
        }
    } finally {
        state.pointer.copy(_grabPickPointer);
        state.raycaster.setFromCamera(state.pointer, state.camera);
    }
    return directHit;
}

function updateGrabCursor() {
    const canvas = state.renderer?.domElement;
    if (canvas?.style) canvas.style.cursor = _grabbedAnimal ? 'grabbing' : state.currentMode === 'grab' ? 'grab' : '';
}

function clearPreview() {
    state.previewGroup.clear();
    state.targetGuideOpacity = 0;
    if (state.rollOverMaterial) state.rollOverMaterial.opacity = 0;
    hideFoodGhost();
    hideEyesPreview();
    updateGrabCursor();
}

function hideEyesPreview() {
    if (state.eyesPreview) state.eyesPreview.visible = false;
}

function showEyesPreview(hit) {
    if (!hit || hit.animal || hit.food || hit.train || hit.object === state.plane) { hideEyesPreview(); return; }
    if (!state.eyesPreview) {
        const group = new THREE.Group();
        group.userData.material = new THREE.MeshBasicMaterial({ color: 0x58e8ca, transparent: true, opacity: 0.28, depthWrite: false });
        group.userData.outlineGeometry = new THREE.EdgesGeometry(state.cubeGeo);
        group.userData.outlineMaterial = new THREE.LineBasicMaterial({ color: 0x24bd9b, transparent: true, opacity: 0.9, depthTest: false });
        state.eyesPreview = group;
    }
    const group = state.eyesPreview;
    if (group.parent !== state.scene) state.scene.add(group);
    const connected = collectConnectedBlocks(hit.object);
    if (group.userData.seed !== hit.object || group.userData.blockCount !== objects.length) {
        group.clear();
        for (const block of connected.slice(0, 96)) {
            const ghost = new THREE.Mesh(state.cubeGeo, group.userData.material);
            ghost.position.copy(block.position);
            ghost.scale.setScalar(1.015);
            const outline = new THREE.LineSegments(group.userData.outlineGeometry, group.userData.outlineMaterial);
            outline.renderOrder = 5;
            ghost.add(outline);
            group.add(ghost);
        }
        group.userData.seed = hit.object;
        group.userData.blockCount = objects.length;
    }
    group.userData.material.color.setHex(connected.length > 96 ? 0xffa47a : 0x58e8ca);
    group.visible = true;
}

function clearGrabTimer() {
    if (_grabHoldTimer !== null) clearTimeout(_grabHoldTimer);
    _grabHoldTimer = null;
}

function beginAnimalGrab(animal, event) {
    if (!animals.includes(animal)) return;
    _grabbedAnimal = animal;
    // End rolling/sliding visual offsets before choosing the pickup height.
    setGrabbedAnimal(animal);
    animal.grabbed = true;
    _grabGroundY = getGroundHeightBelow(animal.mesh.position.x, animal.mesh.position.y + 1, animal.mesh.position.z);
    if (state.controls) {
        _controlsWereEnabled = state.controls.enabled;
        state.controls.enabled = false;
    }
    const hoverY = Math.max(animal.mesh.position.y, _grabGroundY + GRAB_HOVER_HEIGHT);
    animal.mesh.position.y = hoverY;
    if (animal.body) {
        animal.body.position.y = hoverY + animal.heightOffset * (voxelSize / 20);
        animal.body.velocity.set(0, 0, 0);
    }
    // The hand tool locks OrbitControls before it can capture a touch itself.
    const canvas = state.renderer.domElement;
    if (canvas.setPointerCapture && event) {
        canvas.setPointerCapture(event.pointerId);
        activePointer.captureTarget = canvas;
    }
    clearPreview();
}

function releasePointerCapture() {
    const target = activePointer?.captureTarget;
    if (target?.hasPointerCapture(activePointer.id)) target.releasePointerCapture(activePointer.id);
}

function releaseAnimal() {
    if (!_grabbedAnimal) return;
    const animal = _grabbedAnimal;
    animal.grabbed = false;
    if (animals.includes(animal)) {
        animal.state = 'falling';
        if (animal.body) {
            if (_grabGroundY !== null) animal.body.position.y = _grabGroundY + animal.heightOffset * (voxelSize / 20);
            animal.body.wakeUp();
        }
        snapAnimalToGround(animal);
    }
    setGrabbedAnimal(null);
    _grabbedAnimal = null;
    _grabGroundY = null;
    if (state.controls) state.controls.enabled = _controlsWereEnabled;
}

function finishTrainGesture(commit = false) {
    if (!_trainDrag) return;
    const drag = _trainDrag;
    _trainDrag = null;
    try {
        if (drag.started && state.train === drag.train) {
            if (!commit || !finishTrainRoute()) cancelTrainRoute();
        }
    } finally {
        if (state.controls) state.controls.enabled = drag.controlsWereEnabled;
    }
}

function pointerOverInterface(event) {
    return isInterface(event.target) || isInterface(document.elementFromPoint?.(event.clientX, event.clientY));
}

function sampleTrainRoute(event) {
    setPointerRay(event);
    if (!state.raycaster.ray.intersectPlane(_trainPlane, _trainIntersect)) return;
    if (!Number.isFinite(_trainIntersect.x + _trainIntersect.z)) return;
    if (!_trainDrag.started) {
        // 기관차 표면의 클릭 위치가 아니라 엔진의 현재 위치에서 길을 시작한다.
        if (!beginTrainRoute(_trainDrag.train)) { onPointerCancel(event); return; }
        _trainDrag.started = true;
    }
    appendTrainRoutePoint(_trainIntersect.clone());
}

export function onPointerCancel(event) {
    if (event?.type === 'pointercancel' && activePointer && event.pointerId !== activePointer.id) return;
    clearGrabTimer();
    releaseAnimal();
    finishTrainGesture();
    if (state.isDraggingRemove) pushHistory();
    state.isDraggingBuild = false;
    state.isDraggingRemove = false;
    state.verticalBuildOffset = 0;
    releasePointerCapture();
    activePointer = null;
    clearPreview();
    if (!event || event.type === 'blur') {
        Object.keys(state.keys).forEach(key => { state.keys[key] = false; });
        state.velocity.set(0, 0, 0);
    }
}

export function onKeyDown(event) {
    if (isEditingText(event.target)) return;
    const key = event.code?.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (event.code === 'Escape') { onPointerCancel(); return; }
    if (event.ctrlKey || event.metaKey) {
        if (key === 'z' || key === 'y') {
            event.preventDefault();
            onPointerCancel();
            if (key === 'y' || event.shiftKey) redo();
            else undo();
        }
        return;
    }
    if (event.altKey) return;
    if (event.code === 'KeyF' && !event.repeat) frameCamera();
    if (state.isDraggingBuild && (key === 'q' || key === 'e')) {
        event.preventDefault();
        state.keys[key] = false;
        state.verticalBuildOffset += key === 'e' ? 1 : -1;
        updatePreviewPath(state.rollOverMesh.position);
        return;
    }
    if (Object.prototype.hasOwnProperty.call(state.keys, key)) state.keys[key] = true;
}

export function onKeyUp(event) {
    const key = event.code?.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(state.keys, key)) state.keys[key] = false;
}

export function onWindowResize() {
    state.camera.aspect = window.innerWidth / window.innerHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    if (state.composer) state.composer.setSize(window.innerWidth, window.innerHeight);
}

export function onPointerMove(event) {
    if (activePointer && event.pointerId !== activePointer.id) return;
    if (activePointer && Math.hypot(event.clientX - state.downPointerPos.x, event.clientY - state.downPointerPos.y) >= TAP_DISTANCE) {
        activePointer.moved = true;
        clearGrabTimer();
    }
    if (_trainDrag) {
        if (state.train !== _trainDrag.train) { onPointerCancel(event); return; }
        if (pointerOverInterface(event)) return;
        if (activePointer?.moved) sampleTrainRoute(event);
        return;
    }
    if (_grabbedAnimal && !animals.includes(_grabbedAnimal)) {
        onPointerCancel();
        return;
    }
    if (isInterface(event.target) && !_grabbedAnimal) {
        state.targetGuideOpacity = 0;
        hideFoodGhost();
        hideEyesPreview();
        return;
    }
    setPointerRay(event);
    if (_grabbedAnimal) {
        const hits = state.raycaster.intersectObjects(objects.filter(o => o !== state.plane), false);
        let groundY, posX, posZ;
        if (hits.length > 0) {
            const hit = hits[0];
            posX = hit.point.x;
            posZ = hit.point.z;
            const ny = hit.face?.normal.y || 0;
            groundY = ny > 0.5 ? hit.point.y : ny < -0.5
                ? getGroundHeightBelow(posX, hit.point.y - 0.1, posZ)
                : hit.object.position.y + voxelSize / 2;
        } else {
            if (!state.raycaster.ray.intersectPlane(_grabPlane, _grabIntersect)) return;
            posX = _grabIntersect.x;
            posZ = _grabIntersect.z;
            groundY = getGroundHeightAt(posX, posZ);
        }
        _grabGroundY = groundY;
        const hoverY = groundY + GRAB_HOVER_HEIGHT;
        _grabbedAnimal.mesh.position.set(posX, hoverY, posZ);
        if (_grabbedAnimal.body) {
            const halfHeight = _grabbedAnimal.heightOffset * (voxelSize / 20);
            _grabbedAnimal.body.position.set(posX, hoverY + halfHeight, posZ);
            _grabbedAnimal.body.velocity.set(0, 0, 0);
        }
        return;
    }
    if (state.animalMode === 'remove' || event.altKey || event.ctrlKey || event.metaKey || (event.buttons & 6)) {
        state.targetGuideOpacity = 0;
        hideFoodGhost();
        hideEyesPreview();
        return;
    }
    const hit = getHit();
    if (state.currentMode === 'train') {
        state.targetGuideOpacity = 0;
        hideFoodGhost();
        hideEyesPreview();
        return;
    }
    if (state.currentMode === 'grab') {
        clearPreview();
        return;
    }
    if (state.currentMode === 'eyes') {
        state.targetGuideOpacity = 0;
        hideFoodGhost();
        showEyesPreview(hit);
        return;
    }
    hideEyesPreview();
    if (!hit || hit.animal || hit.food || hit.train) {
        state.targetGuideOpacity = 0;
        hideFoodGhost();
        return;
    }
    if (state.currentMode === 'food') {
        state.targetGuideOpacity = 0;
        if (hit.face?.normal.y > 0.5) showFoodGhost(hit.point.x, hit.point.y, hit.point.z);
        else hideFoodGhost();
        return;
    }
    hideFoodGhost();
    if (state.currentMode === 'add') {
        const pos = gridPosition(hit);
        state.rollOverMesh.position.copy(pos);
        state.rollOverMaterial.color.set(0x00ff00);
        state.targetGuideOpacity = canPreview(pos) ? 0.5 : 0;
        if (state.isDraggingBuild) updatePreviewPath(pos);
    } else if (hit.object !== state.plane) {
        state.rollOverMaterial.color.set(0xff0000);
        state.targetGuideOpacity = 0.5;
        state.rollOverMesh.position.copy(hit.object.position);
        if (state.isDraggingRemove) removeVoxel(hit.object);
    } else state.targetGuideOpacity = 0;
}

export function onPointerDown(event) {
    if (activePointer && event.pointerId !== activePointer.id) {
        onPointerCancel();
        return;
    }
    if (event.button !== 0 || event.isPrimary === false || event.altKey || event.ctrlKey || event.metaKey || isInterface(event.target)) return;
    onPointerCancel(event);
    state.downPointerPos.set(event.clientX, event.clientY);
    state.pointerDownTime = performance.now();
    activePointer = { id: event.pointerId, moved: false, entity: false };
    setPointerRay(event);
    const hit = getHit();
    if (state.animalMode === 'remove') return;
    if (state.currentMode === 'grab') {
        activePointer.entity = true;
        const grabHit = getGrabHit(event, hit);
        if (grabHit?.animal) beginAnimalGrab(grabHit.animal, event);
        return;
    }
    if (hit?.train) {
        activePointer.entity = true;
        _trainDrag = { train: hit.train, started: false, controlsWereEnabled: state.controls?.enabled ?? true };
        // main.js가 이 핸들러를 캡처 단계에 연결하여 터치 오빗보다 먼저 잠근다.
        if (state.controls) state.controls.enabled = false;
        clearPreview();
        return;
    }
    if (state.currentMode === 'train') return;
    if (hit?.animal) {
        activePointer.entity = true;
        if (state.currentMode === 'food' || (state.currentMode === 'eyes' && !hit.animal.livingId)) return;
        const hitAnimal = hit.animal;
        _grabHoldTimer = setTimeout(() => {
            _grabHoldTimer = null;
            if (!activePointer || !animals.includes(hitAnimal)) return;
            beginAnimalGrab(hitAnimal, event);
        }, GRAB_HOLD_MS);
        return;
    }
    if (!hit || hit.food) { activePointer.entity = true; return; }
    const canDrag = event.pointerType !== 'touch';
    if (state.currentMode === 'add' && canDrag) {
        state.isDraggingBuild = true;
        state.verticalBuildOffset = 0;
        state.dragStartPos.copy(gridPosition(hit));
        state.rollOverMesh.position.copy(state.dragStartPos);
        addPreviewBlock(state.dragStartPos);
    } else if (state.currentMode === 'remove' && canDrag && hit.object !== state.plane) {
        state.isDraggingRemove = true;
        removeVoxel(hit.object);
    }
}

export function onPointerUp(event) {
    if (!activePointer || event.pointerId !== activePointer.id || event.button !== 0) return;
    if (_trainDrag) {
        const canCommit = state.train === _trainDrag.train && !pointerOverInterface(event);
        if (canCommit && _trainDrag.started) sampleTrainRoute(event);
        finishTrainGesture(canCommit);
        activePointer = null;
        clearGrabTimer();
        clearPreview();
        return;
    }
    const interaction = activePointer;
    releasePointerCapture();
    activePointer = null;
    clearGrabTimer();
    if (_grabbedAnimal) {
        releaseAnimal();
        clearPreview();
        return;
    }
    const wasBuilding = state.isDraggingBuild;
    const wasRemoving = state.isDraggingRemove;
    const overInterface = isInterface(document.elementFromPoint?.(event.clientX, event.clientY) || event.target);
    if (wasBuilding && !overInterface) {
        for (const child of state.previewGroup.children) placeVoxel(child.position, state.currentSlot, true);
        pushHistory();
    }
    if (wasRemoving) pushHistory();
    state.isDraggingBuild = false;
    state.isDraggingRemove = false;
    clearPreview();
    if (wasBuilding || wasRemoving || overInterface || interaction.moved) return;
    if (state.currentMode === 'grab') {
        state.onToyNotice?.('친구를 누른 채 끌어줘! 놓으면 사뿐 내려와 ✋');
        return;
    }
    const dist = Math.hypot(event.clientX - state.downPointerPos.x, event.clientY - state.downPointerPos.y);
    if (dist >= TAP_DISTANCE || performance.now() - state.pointerDownTime >= 500) return;
    setPointerRay(event);
    const hit = getHit();
    if (!hit) {
        if (state.currentMode === 'eyes') state.onToyNotice?.('눈을 붙일 블록을 먼저 골라줘! 👀');
        return;
    }
    if (state.animalMode === 'remove') {
        if (hit.train) clearTrain();
        else if (hit.animal) removeAnimalWithEffect(hit.animal);
        else if (hit.food) removeFoodWithEffect(hit.food);
        return;
    }
    if (hit.train) return;
    if (state.currentMode === 'train') {
        if (hit.object !== state.plane) {
            state.onToyNotice?.('기차는 블록 위가 아닌 빈 바닥에 놓아줘! 🚂');
        } else {
            spawnTrain(new THREE.Vector3(hit.point.x, 0, hit.point.z));
        }
        return;
    }
    if (state.currentMode === 'eyes') {
        if (hit.animal?.livingId) {
            triggerClickAction(hit.animal);
            state.onToyNotice?.(hit.animal.abilityDescription || '반가워! 나랑 놀자 ✨');
        } else if (hit.animal) state.onToyNotice?.('이미 살아 있는 친구야! 간식을 먹여볼까? 🍎');
        else if (!hit.food && hit.object !== state.plane) {
            const normal = hit.face.normal.clone();
            if (Math.abs(normal.y) > 0.5) {
                // A top tap should still give the friend a face looking at us.
                normal.copy(state.camera.position).sub(hit.object.position);
                normal.y = 0;
                if (normal.lengthSq() < 0.001) normal.set(0, 0, 1);
                else normal.normalize();
            }
            const result = awakenBlocks(hit.object, normal);
            if (!result.ok) state.onToyNotice?.(result.reason);
            else state.onToyNotice?.(`반가워! ${result.animal.abilityName || '새 블록 친구'}가 태어났어 ✨`);
        } else state.onToyNotice?.('블록에 눈을 붙여줘! 붙어 있는 블록들이 함께 살아나 👀');
        return;
    }
    if (state.currentMode === 'food' && hit.animal) {
        applySnack(hit.animal, state.snackIngredients);
        hit.animal.isEating = true;
        hit.animal.eatTimer = 0.6;
        playSound('food-eat');
        return;
    }
    if (hit.animal) { triggerClickAction(hit.animal); return; }
    if (interaction.entity || hit.food) return;
    if (state.currentMode === 'food') {
        if (hit.face?.normal.y > 0.5) spawnFood(hit.point.clone());
    } else if (state.currentMode === 'add') placeVoxel(gridPosition(hit));
    else if (hit.object !== state.plane) removeVoxel(hit.object);
}

function gridPosition(hit) {
    return hit.point.clone().add(hit.face.normal).divideScalar(voxelSize).floor().multiplyScalar(voxelSize).addScalar(voxelSize / 2);
}

function canPreview(pos) {
    return pos.y >= voxelSize / 2 && !objects.some(obj => obj !== state.plane && obj.position.distanceToSquared(pos) < 1);
}

function updatePreviewPath(currentPos) {
    state.previewGroup.clear();
    const dx = Math.round((currentPos.x - state.dragStartPos.x) / voxelSize);
    const dz = Math.round((currentPos.z - state.dragStartPos.z) / voxelSize);
    const dy = state.verticalBuildOffset;
    let targetDx = dx, targetDz = dz;
    const absX = Math.abs(dx), absZ = Math.abs(dz);
    if (absX > absZ * 1.5) targetDz = 0;
    else if (absZ > absX * 1.5) targetDx = 0;
    else {
        const diag = Math.max(absX, absZ);
        targetDx = Math.sign(dx) * diag;
        targetDz = Math.sign(dz) * diag;
    }
    const steps = Math.max(Math.abs(targetDx), Math.abs(dy), Math.abs(targetDz));
    if (steps === 0) { addPreviewBlock(state.dragStartPos); return; }
    for (let i = 0; i <= Math.min(steps, MAX_PATH_BLOCKS - 1); i++) {
        const pos = state.dragStartPos.clone().add(new THREE.Vector3(
            Math.round(targetDx / steps * i) * voxelSize,
            Math.round(dy / steps * i) * voxelSize,
            Math.round(targetDz / steps * i) * voxelSize
        ));
        addPreviewBlock(pos);
    }
}

function addPreviewBlock(pos) {
    if (!canPreview(pos)) return;
    const mesh = new THREE.Mesh(state.cubeGeo, state.previewMaterial);
    mesh.position.copy(pos);
    state.previewGroup.add(mesh);
    state.previewMaterial.color.copy(materials[state.currentSlot].color);
}
