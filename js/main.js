import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { state, guiParams, objects, voxelSize, materials, presetColors, numCustomSlots, explodingBricks } from './state.js';
import { getFullSnapshot, disposeExplodingBrick, placeVoxel, pushHistory } from './scene.js';
import { updatePreview } from './camera.js';
import { onPointerMove, onPointerDown, onPointerUp, onPointerCancel, onWindowResize, onKeyDown, onKeyUp } from './input.js';
import { setupPalette, setupModeButtons, setupGUI, setupSnapControls } from './ui.js';
import { animals, updateDogs } from './entities.js';
import { updateFoods, initFoodGhost } from './food.js';
import { updateMagicEffects } from './magic.js';

function init() {
    state.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 10000);
    state.camera.position.set(500, 800, 1300);
    state.camera.lookAt(0, 0, 0);

    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0xe6f2ff);

    const rollOverGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    state.rollOverMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, opacity: 0.5, transparent: true });
    state.rollOverMesh = new THREE.Mesh(rollOverGeo, state.rollOverMaterial);
    state.scene.add(state.rollOverMesh);

    const boardSize = 2000;
    const geometry = new THREE.PlaneGeometry(boardSize, boardSize);
    geometry.rotateX(-Math.PI / 2);
    state.plane = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
    state.scene.add(state.plane);
    objects.push(state.plane);

    state.world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -1470, 0),  // 1.5x 낙하 속도 (기존 -980)
        allowSleep: false   // sleep으로 인한 AI velocity 무시 버그 방지
    });

    // 공유 물리 재질 등록 (동물↔바닥/블록 충돌에 사용)
    state.groundMaterial = new CANNON.Material('ground');
    state.animalMaterial = new CANNON.Material('animal');

    // 바닥-동물 ContactMaterial: 마찰 0.4, 반발 0.1
    state.world.addContactMaterial(new CANNON.ContactMaterial(
        state.groundMaterial, state.animalMaterial,
        { friction: 0.4, restitution: 0.1 }
    ));
    // 동물-동물 ContactMaterial: 서로 밀려남
    state.world.addContactMaterial(new CANNON.ContactMaterial(
        state.animalMaterial, state.animalMaterial,
        { friction: 0.3, restitution: 0.2 }
    ));

    const groundBody = new CANNON.Body({
        type: CANNON.Body.STATIC,
        shape: new CANNON.Plane(),
        material: state.groundMaterial
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    state.world.addBody(groundBody);

    state.scene.add(state.previewGroup);

    const boardGeo = new THREE.PlaneGeometry(boardSize, boardSize);
    boardGeo.rotateX(-Math.PI / 2);
    const boardMat = new THREE.MeshPhysicalMaterial({
        color: guiParams.board.color,
        roughness: guiParams.board.roughness,
        side: THREE.FrontSide
    });
    state.baseBoard = new THREE.Mesh(boardGeo, boardMat);
    state.baseBoard.position.y = -0.05;
    state.baseBoard.receiveShadow = true;
    state.scene.add(state.baseBoard);

    presetColors.forEach((colorHex, idx) => {
        materials[`preset-${idx}`] = new THREE.MeshPhysicalMaterial({
            color: colorHex, roughness: 0.2
        });
    });
    for (let i = 0; i < numCustomSlots; i++) {
        materials[`custom-${i}`] = new THREE.MeshPhysicalMaterial({
            color: '#FFFFFF', roughness: 0.2
        });
    }

    state.raycaster = new THREE.Raycaster();
    state.pointer = new THREE.Vector2();

    state.ambientLight = new THREE.AmbientLight(0x404040, 5.0);
    state.scene.add(state.ambientLight);

    state.directionalLight = new THREE.DirectionalLight(0xffffff, 3);
    state.directionalLight.position.set(500, 1500, 750);
    state.directionalLight.castShadow = true;
    state.directionalLight.shadow.mapSize.width = 4096;
    state.directionalLight.shadow.mapSize.height = 4096;
    state.directionalLight.shadow.camera.near = 0.5;
    state.directionalLight.shadow.camera.far = 5000;
    const d = 1500;
    state.directionalLight.shadow.camera.left = -d;
    state.directionalLight.shadow.camera.right = d;
    state.directionalLight.shadow.camera.top = d;
    state.directionalLight.shadow.camera.bottom = -d;
    state.directionalLight.shadow.bias = -0.0005;
    state.directionalLight.shadow.normalBias = 0.02;
    state.directionalLight.shadow.radius = 2;
    state.scene.add(state.directionalLight);

    state.renderer = new THREE.WebGLRenderer({ antialias: true });
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.setSize(window.innerWidth, window.innerHeight);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(state.renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(state.renderer);
    state.scene.environment = pmremGenerator.fromScene(new THREE.Scene()).texture;
    pmremGenerator.dispose();

    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.mouseButtons = {
        LEFT: undefined,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE
    };
    state.controls.enablePan = true;
    state.renderer.domElement.addEventListener('pointerdown', event => {
        state.controls.mouseButtons.LEFT = event.altKey ? THREE.MOUSE.ROTATE : undefined;
    }, { capture: true });

    state.actionHistory.push(getFullSnapshot());

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onPointerCancel);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) onPointerCancel();
        previousFrameTime = null;
        simulationAccumulator = 0;
    });
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('contextmenu', event => event.preventDefault());

    state.composer = new EffectComposer(state.renderer);
    const renderPass = new RenderPass(state.scene, state.camera);
    state.composer.addPass(renderPass);

    state.saoPass = new SAOPass(state.scene, state.camera);
    state.saoPass.params.saoIntensity = guiParams.ao.intensity * 0.00005;
    state.saoPass.params.saoKernelRadius = guiParams.ao.radius;
    state.saoPass.params.saoBlur = true;
    state.saoPass.params.saoBias = 0.5;
    state.composer.addPass(state.saoPass);

    const outputPass = new OutputPass();
    state.composer.addPass(outputPass);

    state.createToyStarter = createToyStarter;
    setupPalette();
    setupModeButtons();
    setupGUI();
    setupSnapControls();
    initPreview();
    initFoodGhost();
}

function createToyStarter() {
    // A six-block blank friend, created only when the child asks for one.
    const pattern = [
        [-1, 0, 0, 'preset-10'], [1, 0, 0, 'preset-10'],
        [-1, 1, 0, 'preset-20'], [0, 1, 0, 'preset-20'], [1, 1, 0, 'preset-20'],
        [0, 2, 0, 'preset-9']
    ];
    let center = null;
    for (const z of [25, 275, -225, 525, -475, 775, -725]) {
        for (const x of [25, 275, -225, 525, -475, 775, -725]) {
            const occupied = objects.some(block => block !== state.plane
                && Math.abs(block.position.x - x) < 150 && Math.abs(block.position.z - z) < 100);
            if (!occupied) { center = new THREE.Vector3(x, 25, z); break; }
        }
        if (center) break;
    }
    if (!center) { state.onToyNotice?.('블록 친구가 태어날 작은 빈자리를 만들어줘!'); return false; }
    for (const [x, y, z, slot] of pattern) {
        placeVoxel(center.clone().add(new THREE.Vector3(x, y, z).multiplyScalar(voxelSize)), slot, true);
    }
    pushHistory();
    const target = center.clone().add(new THREE.Vector3(0, voxelSize, 0));
    const portraitDistance = Math.max(1, 0.72 / state.camera.aspect);
    state.camera.position.copy(target).add(new THREE.Vector3(320, 250, 600).multiplyScalar(portraitDistance));
    state.controls.target.copy(target);
    state.velocity.set(0, 0, 0);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
    state.onToyNotice?.('분홍색 머리에 눈을 붙여봐! 👀');
    return true;
}

function initPreview() {
    const container = document.getElementById('preview-container');
    const width = 200;
    const height = 200;
    const aspect = width / height;
    const d = 500;
    state.previewCamera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 10000);
    state.previewCamera.position.set(500, 500, 500);
    state.previewCamera.lookAt(0, 0, 0);

    // 프리뷰 전용 씬: 조명 없음 → MeshBasicMaterial로 원색 그대로 표현
    state.previewScene = new THREE.Scene();
    state.previewScene.background = new THREE.Color(0x2d2d2d);

    state.previewRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    state.previewRenderer.setPixelRatio(window.devicePixelRatio);
    state.previewRenderer.setSize(width, height);
    state.previewRenderer.domElement.style.width = '100%';
    state.previewRenderer.domElement.style.height = '100%';
    container.appendChild(state.previewRenderer.domElement);
}

const fixedDt = 1 / 60;
let previousFrameTime = null;
let simulationAccumulator = 0;
const cameraMove = new THREE.Vector3();
const cameraShake = new THREE.Vector3();

function animate(now) {
    requestAnimationFrame(animate);

    // Rendering frequency must not change game speed. Keep collision steps small
    // even at x3, and discard long gaps when returning from another tab.
    const dt = previousFrameTime === null ? 0 : Math.max(0, Math.min((now - previousFrameTime) / 1000, 0.1));
    previousFrameTime = now;
    const scaledDt = dt * (state.gameSpeed ?? 1);
    simulationAccumulator += scaledDt;
    while (simulationAccumulator + 1e-10 >= fixedDt) {
        if (state.world) state.world.step(fixedDt);
        updateDogs(fixedDt);
        updateFoods(fixedDt);
        updateMagicEffects(animals, fixedDt);
        simulationAccumulator -= fixedDt;
    }

    for (let i = explodingBricks.length - 1; i >= 0; i--) {
        const item = explodingBricks[i];
        item.elapsed = (item.elapsed ?? 0) + scaledDt;
        const elapsed = item.elapsed;

        const maxLife = item.maxLife ?? 7.0;
        const fadeLife = item.fadeLife ?? 6.0;

        if (elapsed > maxLife) {
            disposeExplodingBrick(item);
            explodingBricks.splice(i, 1);
            continue;
        }

        if (item.body) {
            item.mesh.position.copy(item.body.position);
            item.mesh.quaternion.copy(item.body.quaternion);

            if (elapsed > fadeLife) {
                const fadeDuration = maxLife - fadeLife;
                const s = 1.0 - (elapsed - fadeLife) / fadeDuration;
                if (item.baseScale) item.mesh.scale.copy(item.baseScale).multiplyScalar(Math.max(s, 0.01));
                else item.mesh.scale.setScalar(Math.max(s, 0.01));
            }

            // Hide/remove blocks that fall way off the board
            if (item.body.position.y < -1000) {
                disposeExplodingBrick(item);
                explodingBricks.splice(i, 1);
            }
        } else {
            // Fallback for old snapshot objects if any
            disposeExplodingBrick(item);
            explodingBricks.splice(i, 1);
        }
    }

    const frameScale = dt * 60;
    const friction = Math.pow(0.85, frameScale);
    const accel = 2.0 * 0.85 * (1 - friction) / (1 - 0.85);

    const forward = new THREE.Vector3();
    state.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, state.camera.up).normalize();

    state.velocity.multiplyScalar(friction);
    if (state.keys.w) state.velocity.addScaledVector(forward, accel);
    if (state.keys.s) state.velocity.addScaledVector(forward, -accel);
    if (state.keys.a) state.velocity.addScaledVector(right, -accel);
    if (state.keys.d) state.velocity.addScaledVector(right, accel);
    if (state.keys.e) state.velocity.y += accel;
    if (state.keys.q) state.velocity.y -= accel;

    cameraMove.copy(state.velocity).multiplyScalar(frameScale);
    state.camera.position.add(cameraMove);
    state.controls.target.add(cameraMove);

    if (state.rollOverMaterial) {
        state.rollOverMaterial.opacity += (state.targetGuideOpacity - state.rollOverMaterial.opacity) * (1 - Math.pow(0.8, frameScale));
        if (state.rollOverMaterial.opacity > 0.01) {
            state.rollOverMesh.visible = true;
        } else {
            state.rollOverMesh.visible = false;
        }
    }

    state.controls.update();
    updatePreview();

    // Apply shake only for rendering so it cannot permanently move the camera.
    cameraShake.set(0, 0, 0);
    if (state.screenShakeTimer > 0) {
        state.screenShakeTimer -= scaledDt;
        if (state.screenShakeTimer < 0) state.screenShakeTimer = 0;
        const decay = state.screenShakeTimer / 0.5;
        const shakeAmt = state.screenShakeIntensity * decay;
        cameraShake.set((Math.random() - 0.5) * 2 * shakeAmt, (Math.random() - 0.5) * shakeAmt, 0);
    }
    state.camera.position.add(cameraShake);

    if (state.composer) {
        state.composer.render();
    } else {
        state.renderer.render(state.scene, state.camera);
    }
    state.camera.position.sub(cameraShake);
    state.camera.updateMatrixWorld();
}

init();
requestAnimationFrame(animate);
