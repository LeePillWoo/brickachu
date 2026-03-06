import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { state, guiParams, objects, voxelSize, materials, presetColors, numCustomSlots, explodingBricks } from './state.js';
import { pushHistory, getFullSnapshot } from './scene.js';
import { updatePreview } from './camera.js';
import { onPointerMove, onPointerDown, onPointerUp, onWindowResize, onKeyDown, onKeyUp } from './input.js';
import { setupPalette, setupModeButtons, setupGUI, setupSnapControls } from './ui.js';
import { updateDogs } from './entities.js';
import { updateFoods, initFoodGhost } from './food.js';

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

    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.mouseButtons = {
        LEFT: THREE.MOUSE.NONE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE
    };
    state.controls.enablePan = true;

    state.actionHistory.push(getFullSnapshot());

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('contextmenu', event => event.preventDefault());

    state.composer = new EffectComposer(state.renderer);
    const renderPass = new RenderPass(state.scene, state.camera);
    state.composer.addPass(renderPass);

    state.saoPass = new SAOPass(state.scene, state.camera);
    state.saoPass.params.saoIntensity = guiParams.ao.intensity * 0.00005;
    state.saoPass.params.saoRadius = guiParams.ao.radius;
    state.saoPass.params.saoBlur = true;
    state.saoPass.params.saoBias = 0.5;
    state.composer.addPass(state.saoPass);

    const outputPass = new OutputPass();
    state.composer.addPass(outputPass);

    setupPalette();
    setupModeButtons();
    setupGUI();
    setupSnapControls();
    initPreview();
    initFoodGhost();
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

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = 1 / 60; // Fixed time step
    const scaledDt = dt * (state.gameSpeed ?? 1);
    if (state.world) {
        state.world.step(scaledDt);
    }

    updateDogs(scaledDt);
    updateFoods(scaledDt);

    for (let i = explodingBricks.length - 1; i >= 0; i--) {
        const item = explodingBricks[i];
        const elapsed = (now - item.startTime) / 1000;

        const maxLife = item.maxLife ?? 7.0;
        const fadeLife = item.fadeLife ?? 6.0;

        if (elapsed > maxLife) {
            if (item.mesh) state.scene.remove(item.mesh);
            if (item.body && state.world) state.world.removeBody(item.body);
            explodingBricks.splice(i, 1);
            continue;
        }

        if (item.body) {
            item.mesh.position.copy(item.body.position);
            item.mesh.quaternion.copy(item.body.quaternion);

            if (elapsed > fadeLife) {
                const fadeDuration = maxLife - fadeLife;
                const s = 1.0 - (elapsed - fadeLife) / fadeDuration;
                item.mesh.scale.set(Math.max(s, 0.01), Math.max(s, 0.01), Math.max(s, 0.01));
            }

            // Hide/remove blocks that fall way off the board
            if (item.body.position.y < -1000) {
                state.scene.remove(item.mesh);
                state.world.removeBody(item.body);
                explodingBricks.splice(i, 1);
            }
        } else {
            // Fallback for old snapshot objects if any
            state.scene.remove(item);
            explodingBricks.splice(i, 1);
        }
    }

    const accel = 2.0;
    const friction = 0.85;

    const forward = new THREE.Vector3();
    state.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(forward, state.camera.up).normalize();

    if (state.keys.w) state.velocity.addScaledVector(forward, accel);
    if (state.keys.s) state.velocity.addScaledVector(forward, -accel);
    if (state.keys.a) state.velocity.addScaledVector(right, -accel);
    if (state.keys.d) state.velocity.addScaledVector(right, accel);
    if (state.keys.e) state.velocity.y += accel;
    if (state.keys.q) state.velocity.y -= accel;

    state.velocity.multiplyScalar(friction);
    state.camera.position.add(state.velocity);

    if (state.velocity.lengthSq() > 0.1) {
        const lookDirection = new THREE.Vector3();
        state.camera.getWorldDirection(lookDirection);
        const distance = state.controls.target.distanceTo(state.camera.position);
        state.controls.target.copy(state.camera.position).addScaledVector(lookDirection, Math.max(distance, 100));
    }

    if (state.rollOverMaterial) {
        state.rollOverMaterial.opacity += (state.targetGuideOpacity - state.rollOverMaterial.opacity) * 0.2;
        if (state.rollOverMaterial.opacity > 0.01) {
            state.rollOverMesh.visible = true;
        } else {
            state.rollOverMesh.visible = false;
        }
    }

    // ── 화면 흔들림 (HEAVY 동물 클릭 시) ──
    if (state.screenShakeTimer > 0) {
        state.screenShakeTimer -= dt;
        if (state.screenShakeTimer < 0) state.screenShakeTimer = 0;
        const decay = state.screenShakeTimer / 0.5;
        const shakeAmt = state.screenShakeIntensity * decay;
        state.camera.position.x += (Math.random() - 0.5) * 2 * shakeAmt;
        state.camera.position.y += (Math.random() - 0.5) * shakeAmt;
    }

    state.controls.update();
    updatePreview();

    if (state.composer) {
        state.composer.render();
    } else {
        state.renderer.render(state.scene, state.camera);
    }
}

init();
animate();
