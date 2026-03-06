import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, voxelSize, objects } from './state.js';

export const animals = [];
export const dogs = animals; // Aliased for backwards compatibility in main.js
const MAX_ANIMALS = 10;

// 기본 지면 높이 (바닥 plane 기준)
const GROUND_BASE_HEIGHT = 80;

// 현재 잡고 있는 동물 참조
export let grabbedAnimal = null;
export function setGrabbedAnimal(a) { grabbedAnimal = a; }

// 모든 동물 제거
export function clearAllAnimals() {
    while (animals.length > 0) {
        const animal = animals.pop();
        if (animal.mesh) state.scene.remove(animal.mesh);
        if (animal.body && state.world) state.world.removeBody(animal.body);
    }
    grabbedAnimal = null;
}

// ── 지형/천장 계산용 Raycaster ──
const _groundRaycaster = new THREE.Raycaster();
const _groundRayDown = new THREE.Vector3(0, -1, 0);
const _groundRayUp = new THREE.Vector3(0, 1, 0);
const MAX_GROUND_CHECK_HEIGHT = 5000;
const RAY_ORIGIN = new THREE.Vector3();

function getBlockObjects() {
    return objects && state.plane ? objects.filter(o => o !== state.plane) : [];
}

/** (x, yStart, z)에서 아래 방향(-Y)으로 레이. 블록 윗면 또는 기본 지면(Plane) 감지. 충돌 없으면 defaultY(GROUND_BASE_HEIGHT) 반환 */
export function getGroundHeightBelow(x, yStart, z, defaultY = GROUND_BASE_HEIGHT) {
    if (!objects || objects.length === 0) return defaultY;
    RAY_ORIGIN.set(x, yStart, z);
    _groundRaycaster.set(RAY_ORIGIN, _groundRayDown);
    const hits = _groundRaycaster.intersectObjects(objects, false);
    if (hits.length > 0) {
        const hit = hits[0];
        if (hit.object === state.plane) return GROUND_BASE_HEIGHT;
        return hit.point.y;
    }
    return defaultY;
}

/** (x, yStart, z)에서 위 방향(+Y)으로 레이를 쏴, 가장 먼저 닿는 블록의 아랫면(천장) Y를 반환. 없으면 Infinity */
export function getCeilingHeightAbove(x, yStart, z) {
    const blockObjects = getBlockObjects();
    if (blockObjects.length === 0) return Infinity;
    RAY_ORIGIN.set(x, yStart, z);
    _groundRaycaster.set(RAY_ORIGIN, _groundRayUp);
    const hits = _groundRaycaster.intersectObjects(blockObjects, false);
    if (hits.length > 0) return hits[0].point.y;
    return Infinity;
}

/** 레거시: (x,z) 열에서 가장 위쪽 바닥(위에서 아래로 첫 충돌). getGroundHeightBelow(x, MAX, z)와 동일 */
export function getGroundHeightAt(x, z, defaultY = GROUND_BASE_HEIGHT) {
    return getGroundHeightBelow(x, MAX_GROUND_CHECK_HEIGHT, z, defaultY);
}

export function snapAnimalToGround(animal) {
    if (!animal || !animal.body || !animal.mesh) return;
    const halfHeight = animal.heightOffset * (voxelSize / 20);
    const groundY = getGroundHeightBelow(
        animal.body.position.x,
        animal.body.position.y + 1,
        animal.body.position.z,
        GROUND_BASE_HEIGHT
    );
    const targetY = groundY + halfHeight;
    animal.body.position.y = targetY;
    animal.mesh.position.copy(animal.body.position);
    animal.mesh.position.y -= halfHeight;
}

// ── 타입별 애니메이션 그룹 / 클릭 액션 매핑 ──
const ANIM_TYPE = {};
[
    // 사족보행: 상하 바운스 + 살짝 기울기
    ['quadruped', ['dog', 'cat', 'sheep', 'horse', 'lion', 'elephant', 'giraffe', 'pig']],
    // 뒤뚱거림: 좌우 기울기 중심
    ['waddling', ['pikachu', 'penguin', 'snorlax', 'jigglypuff', 'meowth', 'squirtle', 'charmander']],
    // 점프: 토끼만 점프 이동
    ['hopping', ['rabbit']],
    // 슬라이딩: 뱀/악어/거북이
    ['sliding', ['snake', 'crocodile', 'turtle']],
    // 특수: 블롭/디지털 느낌
    ['special', ['porygon', 'ditto', 'diglett']],
].forEach(([grp, list]) => list.forEach(name => { ANIM_TYPE[name] = grp; }));

// 그룹별 클릭 액션 타입 매핑
const CLICK_ACTION_MAP = {
    quadruped: 'spin',   // 제자리 회전
    waddling: 'scale',   // 일시적 확대 (통통 튀는 느낌)
    hopping: 'jump',     // 위로 점프
    sliding: 'squash',   // 살짝 눌렸다가 복원
    special: 'pulse',    // 작게 맥동
};

// 클릭 액션 트리거 (input.js에서 호출)
export function triggerClickAction(animal) {
    if (animal.clickActionTimer > 0) return; // 이미 진행 중
    animal.clickActionTimer = 0.75;
    animal.clickActionPhase = 0;
    animal.clickActionType = CLICK_ACTION_MAP[animal.animGroup] || 'spin';
}


function getRandomColor() {
    const r = Math.floor(Math.random() * 200 + 55);
    const g = Math.floor(Math.random() * 200 + 55);
    const b = Math.floor(Math.random() * 200 + 55);
    return (r << 16) | (g << 8) | b;
}

export function spawnDog() {
    if (animals.length >= MAX_ANIMALS) {
        removeOldestAnimal();
    }

    const animalGroup = new THREE.Group();
    const u = voxelSize / 25; // 1/25th scale unit

    const types = [
        'dog', 'cat', 'rabbit', 'sheep', 'snake', 'horse', 'pikachu', 'squirtle', 'charmander',
        'meowth', 'snorlax', 'jigglypuff', 'diglett', 'porygon', 'ditto',
        'lion', 'elephant', 'giraffe', 'penguin', 'crocodile', 'pig', 'turtle'
    ];
    const type = types[Math.floor(Math.random() * types.length)];

    const baseColor = getRandomColor();
    const secondaryColor = getRandomColor();
    const accentColor = getRandomColor();

    const matBase = new THREE.MeshPhysicalMaterial({ color: baseColor, roughness: 0.8 });
    const matSec = new THREE.MeshPhysicalMaterial({ color: secondaryColor, roughness: 0.8 });
    const matAcc = new THREE.MeshPhysicalMaterial({ color: accentColor, roughness: 0.8 });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.9 });
    const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.9 });

    function addPart(w, h, d, x, y, z, mat = matBase) {
        const geo = new THREE.BoxGeometry(w * u, h * u, d * u);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x * u, y * u, z * u);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // raycasting으로 동물을 식별하기 위한 태깅 (나중에 animalData 연결)
        mesh.userData.isAnimalPart = true;
        animalGroup.add(mesh);
        return mesh;
    }

    // All dimensions multiplied by 2. Extra nanoblock details added.
    let heightOffset = 20;

    if (type === 'dog') {
        heightOffset = 20;
        addPart(20, 16, 32, 0, 16, 0); // Body
        addPart(16, 16, 16, 0, 32, 24); // Head
        addPart(8, 6, 8, 0, 28, 36, matSec); // Snout
        addPart(2, 2, 2, 0, 31, 40, blackMat); // Nose
        addPart(2, 2, 2, -5, 36, 32, blackMat); addPart(2, 2, 2, 5, 36, 32, blackMat); // Eyes
        addPart(4, 8, 4, -6, 44, 24, matSec); addPart(4, 8, 4, 6, 44, 24, matSec); // Ears
        const tail = addPart(4, 12, 4, 0, 28, -16, matAcc);
        tail.rotation.x = -Math.PI / 4;
        addPart(6, 12, 6, -6, 6, 10); addPart(6, 12, 6, 6, 6, 10); // Front legs
        addPart(6, 12, 6, -6, 6, -10); addPart(6, 12, 6, 6, 6, -10); // Back legs
    } else if (type === 'cat') {
        heightOffset = 16;
        addPart(16, 12, 24, 0, 12, 0); // Body
        addPart(12, 12, 12, 0, 24, 18); // Head
        addPart(2, 2, 2, 0, 22, 25, matSec); // Nose
        addPart(2, 2, 2, -4, 26, 24, blackMat); addPart(2, 2, 2, 4, 26, 24, blackMat); // Eyes
        addPart(4, 6, 4, -4, 32, 20, matAcc); addPart(4, 6, 4, 4, 32, 20, matAcc); // Pointy Ears
        const tail = addPart(4, 20, 4, 0, 24, -12, matSec);
        tail.rotation.x = Math.PI / 6; // High tail
        addPart(4, 8, 4, -4, 4, 8); addPart(4, 8, 4, 4, 4, 8);
        addPart(4, 8, 4, -4, 4, -8); addPart(4, 8, 4, 4, 4, -8);
    } else if (type === 'rabbit') {
        heightOffset = 12;
        addPart(12, 12, 16, 0, 10, 0, whiteMat); // Body
        addPart(10, 10, 10, 0, 20, 10, whiteMat); // Head
        addPart(2, 2, 2, 0, 18, 16, matSec); // Nose
        addPart(2, 2, 2, -3, 22, 15, blackMat); addPart(2, 2, 2, 3, 22, 15, blackMat); // Eyes
        addPart(4, 16, 4, -3, 32, 12, matSec); addPart(4, 16, 4, 3, 32, 12, matSec); // Long Ears
        addPart(6, 6, 6, 0, 12, -10, whiteMat); // Fluff tail
        addPart(4, 6, 4, -4, 3, 6, whiteMat); addPart(4, 6, 4, 4, 3, 6, whiteMat); // Front
        addPart(4, 8, 8, -4, 4, -6, whiteMat); addPart(4, 8, 8, 4, 4, -6, whiteMat); // Back (big feet)
    } else if (type === 'sheep') {
        heightOffset = 20;
        addPart(24, 20, 28, 0, 18, 0, whiteMat); // Fluffy Body
        addPart(12, 12, 16, 0, 28, 22, blackMat); // Head
        addPart(2, 2, 2, -4, 30, 28, whiteMat); addPart(2, 2, 2, 4, 30, 28, whiteMat); // Eyes
        addPart(4, 4, 8, -8, 28, 20, whiteMat); addPart(4, 4, 8, 8, 28, 20, whiteMat); // Ears
        addPart(4, 10, 4, -6, 5, 10, blackMat); addPart(4, 10, 4, 6, 5, 10, blackMat); // Legs
        addPart(4, 10, 4, -6, 5, -10, blackMat); addPart(4, 10, 4, 6, 5, -10, blackMat);
    } else if (type === 'snake') {
        heightOffset = 6;
        addPart(8, 6, 48, 0, 3, 0, matBase); // Long Body
        addPart(10, 8, 12, 0, 4, 30, matSec); // Head
        addPart(2, 2, 2, -4, 8, 34, blackMat); addPart(2, 2, 2, 4, 8, 34, blackMat); // Eyes
        addPart(4, 2, 8, 0, 4, 38, matAcc); // Tongue
    } else if (type === 'horse') {
        heightOffset = 32;
        addPart(20, 20, 40, 0, 32, 0); // Body
        addPart(12, 24, 12, 0, 48, 24); // Neck
        addPart(12, 12, 20, 0, 56, 32); // Head
        addPart(2, 2, 2, -5, 60, 40, blackMat); addPart(2, 2, 2, 5, 60, 40, blackMat); // Eyes
        addPart(4, 24, 8, 0, 48, 18, matSec); // Mane
        const tail = addPart(6, 24, 6, 0, 32, -20, matSec);
        tail.rotation.x = -Math.PI / 8;
        addPart(6, 24, 6, -7, 12, 16, matAcc); addPart(6, 24, 6, 7, 12, 16, matAcc); // Legs
        addPart(6, 24, 6, -7, 12, -16, matAcc); addPart(6, 24, 6, 7, 12, -16, matAcc);
    } else if (type === 'pikachu') {
        heightOffset = 16;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.6 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.8 });
        addPart(16, 20, 16, 0, 10, 0, yellow); // Body
        addPart(16, 16, 16, 0, 28, 4, yellow); // Head
        addPart(2, 2, 2, -5, 28, 12, blackMat); addPart(2, 2, 2, 5, 28, 12, blackMat); // Eyes
        addPart(4, 4, 2, -6, 26, 12, red); addPart(4, 4, 2, 6, 26, 12, red); // Cheeks
        addPart(4, 16, 4, -6, 40, 4, yellow); addPart(4, 4, 4, -6, 48, 4, blackMat); // L Ear
        addPart(4, 16, 4, 6, 40, 4, yellow); addPart(4, 4, 4, 6, 48, 4, blackMat); // R Ear
        const pTail = addPart(4, 20, 12, 0, 16, -12, yellow); pTail.rotation.x = -Math.PI / 4; // Tail
        addPart(4, 6, 6, -4, 3, 4, yellow); addPart(4, 6, 6, 4, 3, 4, yellow); // Feet
    } else if (type === 'squirtle') {
        heightOffset = 16;
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x4fc3f7, roughness: 0.6 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8d6e63, roughness: 0.8 });
        addPart(16, 16, 12, 0, 12, 0, blue); // Body
        addPart(20, 20, 8, 0, 12, -4, brown); // Shell
        addPart(16, 16, 16, 0, 28, 4, blue); // Head
        addPart(2, 4, 2, -5, 30, 12, blackMat); addPart(2, 4, 2, 5, 30, 12, blackMat); // Eyes
        addPart(6, 6, 6, -8, 16, 8, blue); addPart(6, 6, 6, 8, 16, 8, blue); // Arms
        addPart(6, 8, 8, -6, 4, 4, blue); addPart(6, 8, 8, 6, 4, 4, blue); // Legs
        const sTail = addPart(8, 8, 12, 0, 8, -12, blue); sTail.rotation.x = Math.PI / 4;
    } else if (type === 'charmander') {
        heightOffset = 16;
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xff9800, roughness: 0.6 });
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffeb3b, roughness: 0.8 });
        const fire = new THREE.MeshPhysicalMaterial({ color: 0xff3d00, roughness: 0.2, emissive: 0xff3d00 });
        addPart(16, 18, 16, 0, 12, 0, orange); // Body
        addPart(12, 14, 2, 0, 10, 8, yellow); // Belly
        addPart(16, 16, 16, 0, 28, 4, orange); // Head
        addPart(2, 4, 2, -5, 30, 12, blackMat); addPart(2, 4, 2, 5, 30, 12, blackMat); // Eyes
        addPart(4, 8, 4, -8, 16, 8, orange); addPart(4, 8, 4, 8, 16, 8, orange); // Arms
        addPart(6, 8, 8, -6, 4, 4, orange); addPart(6, 8, 8, 6, 4, 4, orange); // Legs
        const cTail = addPart(6, 6, 20, 0, 8, -12, orange); cTail.rotation.x = Math.PI / 6;
        addPart(4, 8, 4, 0, 16, -24, fire); // Tail flame
    } else if (type === 'meowth') {
        heightOffset = 16;
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfffdd0, roughness: 0.7 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.7 });
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.3 });
        addPart(12, 16, 12, 0, 12, 0, cream); // Body
        addPart(16, 16, 12, 0, 28, 2, cream); // Head
        addPart(2, 2, 2, -4, 30, 8, blackMat); addPart(2, 2, 2, 4, 30, 8, blackMat); // Eyes
        addPart(4, 8, 4, -6, 38, 2, brown); addPart(4, 8, 4, 6, 38, 2, brown); // Ears
        addPart(6, 8, 2, 0, 32, 8, gold); // Coin
        addPart(4, 12, 4, -8, 16, 2, cream); addPart(4, 12, 4, 8, 16, 2, cream); // Arms
        addPart(6, 6, 8, -5, 3, 4, brown); addPart(6, 6, 8, 5, 3, 4, brown); // Feet
        const mTail = addPart(4, 20, 4, 0, 12, -8, brown); mTail.rotation.x = Math.PI / 8; // Tail
    } else if (type === 'snorlax') {
        heightOffset = 24;
        const teal = new THREE.MeshPhysicalMaterial({ color: 0x008080, roughness: 0.8 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xf5f5dc, roughness: 0.8 });
        addPart(40, 36, 32, 0, 20, 0, teal); // Big body
        addPart(32, 28, 8, 0, 18, 16, cream); // Belly
        addPart(24, 20, 20, 0, 48, 0, teal); // Head
        addPart(16, 12, 4, 0, 48, 10, cream); // Face mask
        addPart(4, 2, 2, -6, 50, 12, blackMat); addPart(4, 2, 2, 6, 50, 12, blackMat); // Sleepy Eyes
        addPart(6, 8, 6, -8, 60, 0, teal); addPart(6, 8, 6, 8, 60, 0, teal); // Ears
        addPart(10, 16, 10, -24, 24, 4, teal); addPart(10, 16, 10, 24, 24, 4, teal); // Arms
        addPart(10, 10, 12, -12, 5, 12, cream); addPart(10, 10, 12, 12, 5, 12, cream); // Feet
    } else if (type === 'jigglypuff') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffb6c1, roughness: 0.7 });
        addPart(24, 24, 24, 0, 12, 0, pink); // Round body
        addPart(4, 4, 2, -6, 14, 12, blackMat); addPart(4, 4, 2, 6, 14, 12, blackMat); // Eyes
        addPart(6, 8, 6, -6, 26, 0, pink); addPart(6, 8, 6, 6, 26, 0, pink); // Ears
        addPart(8, 6, 6, 0, 26, 8, pink); // Hair tuft
        addPart(6, 6, 6, -12, 12, 4, pink); addPart(6, 6, 6, 12, 12, 4, pink); // Arms
        addPart(8, 4, 10, -6, 2, 8, pink); addPart(8, 4, 10, 6, 2, 8, pink); // Feet
    } else if (type === 'diglett') {
        heightOffset = 8;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const dirt = new THREE.MeshPhysicalMaterial({ color: 0x5c4033, roughness: 1.0 });
        addPart(28, 4, 28, 0, 2, 0, dirt); // Dirt mound
        addPart(16, 20, 16, 0, 12, 0, brown); // Body sticking out
        addPart(2, 4, 2, -4, 16, 8, blackMat); addPart(2, 4, 2, 4, 16, 8, blackMat); // Eyes
        addPart(8, 4, 6, 0, 12, 8, pink); // Big nose
    } else if (type === 'porygon') {
        heightOffset = 16;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x00bfff, roughness: 0.5 });
        addPart(16, 16, 16, 0, 12, 0, pink); // Body
        addPart(12, 12, 12, 0, 28, 6, pink); // Head
        addPart(4, 4, 4, -6, 30, 8, blackMat); addPart(4, 4, 4, 6, 30, 8, blackMat); // Eyes
        addPart(8, 8, 16, 0, 24, 18, blue); // Snout
        addPart(12, 16, 8, -12, 12, 0, blue); addPart(12, 16, 8, 12, 12, 0, blue); // Legs
        const pTail = addPart(8, 8, 12, 0, 12, -12, blue); pTail.rotation.x = -Math.PI / 4; // Tail
    } else if (type === 'ditto') {
        heightOffset = 8;
        const purple = new THREE.MeshPhysicalMaterial({ color: 0xdda0dd, roughness: 0.4, transmission: 0.2 });
        addPart(24, 12, 20, 0, 6, 0, purple); // Blob base
        addPart(16, 12, 16, 0, 14, 0, purple); // Blob top
        addPart(2, 2, 2, -4, 16, 8, blackMat); addPart(2, 2, 2, 4, 16, 8, blackMat); // Dot eyes
        addPart(8, 8, 8, -10, 10, 4, purple); addPart(8, 8, 8, 10, 10, 4, purple); // Little arms
    } else if (type === 'lion') {
        heightOffset = 24;
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xdaa520, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(20, 20, 36, 0, 24, 0, gold); // Body
        // Mane details
        addPart(28, 28, 12, 0, 32, 20, brown); // Mane base
        addPart(16, 16, 16, 0, 32, 28, gold); // Head
        addPart(4, 4, 4, -6, 34, 36, blackMat); addPart(4, 4, 4, 6, 34, 36, blackMat); // Eyes
        addPart(8, 8, 8, 0, 28, 36, blackMat); // Snout
        const tail = addPart(4, 20, 4, 0, 24, -20, gold); tail.rotation.x = -Math.PI / 6;
        addPart(6, 6, 6, 0, 4, -28, brown); // Tail tuft
        addPart(6, 16, 6, -7, 8, 14, gold); addPart(6, 16, 6, 7, 8, 14, gold); // Front legs
        addPart(6, 16, 6, -7, 8, -14, gold); addPart(6, 16, 6, 7, 8, -14, gold); // Back legs
    } else if (type === 'elephant') {
        heightOffset = 36;
        const grey = new THREE.MeshPhysicalMaterial({ color: 0x808080, roughness: 0.8 });
        addPart(36, 32, 48, 0, 32, 0, grey); // Huge body
        addPart(28, 28, 28, 0, 40, 32, grey); // Head
        addPart(4, 4, 4, -10, 44, 46, blackMat); addPart(4, 4, 4, 10, 44, 46, blackMat); // Eyes
        // Trunk details
        addPart(8, 20, 8, 0, 30, 48, grey);
        addPart(6, 10, 6, 0, 15, 48, grey);
        addPart(20, 28, 4, -24, 36, 28, grey); addPart(20, 28, 4, 24, 36, 28, grey); // Big ears
        addPart(12, 20, 12, -12, 10, 16, grey); addPart(12, 20, 12, 12, 10, 16, grey); // Front legs
        addPart(12, 20, 12, -12, 10, -16, grey); addPart(12, 20, 12, 12, 10, -16, grey); // Back legs
    } else if (type === 'giraffe') {
        heightOffset = 60; // Very tall
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(20, 20, 32, 0, 40, 0, yellow); // Body
        // Random brown spots on body
        addPart(6, 2, 6, -10, 40, 5, brown); addPart(6, 2, 6, 10, 40, -5, brown);
        addPart(8, 40, 12, 0, 64, 20, yellow); // Long neck
        addPart(12, 12, 20, 0, 84, 28, yellow); // Head
        addPart(4, 4, 4, -6, 86, 38, blackMat); addPart(4, 4, 4, 6, 86, 38, blackMat); // Eyes
        addPart(4, 6, 4, -4, 92, 24, brown); addPart(4, 6, 4, 4, 92, 24, brown); // Ossicones (horns)
        addPart(6, 36, 6, -7, 18, 12, yellow); addPart(6, 36, 6, 7, 18, 12, yellow); // Front tall legs
        addPart(6, 36, 6, -7, 18, -12, yellow); addPart(6, 36, 6, 7, 18, -12, yellow); // Back tall legs
    } else if (type === 'penguin') {
        heightOffset = 16;
        const black = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.6 });
        const white = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.8 });
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xffa500, roughness: 0.6 });
        addPart(20, 28, 16, 0, 16, 0, black); // Body
        addPart(16, 24, 4, 0, 16, 9, white); // White belly
        addPart(16, 16, 16, 0, 36, 0, black); // Head
        addPart(4, 4, 4, -4, 38, 8, blackMat); addPart(4, 4, 4, 4, 38, 8, blackMat); // Eyes
        addPart(12, 12, 4, 0, 36, 9, white); // White face
        addPart(8, 4, 8, 0, 32, 12, orange); // Beak
        // Wings (flippers) detailed
        addPart(4, 20, 8, -12, 20, 0, black); addPart(4, 20, 8, 12, 20, 0, black);
        addPart(8, 4, 12, -6, 2, 6, orange); addPart(8, 4, 12, 6, 2, 6, orange); // Feet
    } else if (type === 'crocodile') {
        heightOffset = 6;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x2e8b57, roughness: 0.9 });
        addPart(24, 8, 40, 0, 4, 0, green); // Flat body
        addPart(20, 8, 24, 0, 4, 32, green); // Long snout
        addPart(4, 4, 4, -8, 8, 36, blackMat); addPart(4, 4, 4, 8, 8, 36, blackMat); // Eyes
        addPart(16, 8, 36, 0, 4, -36, green); // Tail
        addPart(8, 6, 8, -16, 3, 12, green); addPart(8, 6, 8, 16, 3, 12, green); // Front legs
        addPart(8, 6, 8, -16, 3, -12, green); addPart(8, 6, 8, 16, 3, -12, green); // Back legs
    } else if (type === 'pig') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffc0cb, roughness: 0.8 });
        addPart(24, 20, 32, 0, 14, 0, pink); // Plump body
        addPart(16, 16, 16, 0, 24, 20, pink); // Head
        addPart(4, 4, 4, -4, 26, 28, blackMat); addPart(4, 4, 4, 4, 26, 28, blackMat); // Eyes
        addPart(8, 8, 4, 0, 20, 30, pink); // Snout
        addPart(4, 6, 4, -6, 32, 16, pink); addPart(4, 6, 4, 6, 32, 16, pink); // Ears
        addPart(6, 8, 6, -8, 4, 10, pink); addPart(6, 8, 6, 8, 4, 10, pink); // Front legs
        addPart(6, 8, 6, -8, 4, -10, pink); addPart(6, 8, 6, 8, 4, -10, pink); // Back legs
    } else if (type === 'turtle') {
        heightOffset = 8;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x3cb371, roughness: 0.8 });
        const darkGreen = new THREE.MeshPhysicalMaterial({ color: 0x006400, roughness: 0.9 });
        addPart(28, 12, 32, 0, 8, 0, darkGreen); // Shell
        addPart(12, 12, 12, 0, 8, 20, green); // Head
        addPart(2, 2, 2, -4, 10, 26, blackMat); addPart(2, 2, 2, 4, 10, 26, blackMat); // Eyes
        addPart(8, 4, 8, -16, 4, 12, green); addPart(8, 4, 8, 16, 4, 12, green); // Front flippers
        addPart(8, 4, 8, -16, 4, -12, green); addPart(8, 4, 8, 16, 4, -12, green); // Back flippers
        addPart(4, 4, 8, 0, 4, -20, green); // Small tail
    }

    state.scene.add(animalGroup);

    // 모델 크기(u = voxelSize/25)에 맞춘 물리 바운딩 박스
    // 너비: 모델 최대폭 ≈ 24u, 높이: heightOffset*u*2, 깊이: ≈ 40u
    const hw = (24 * u) / 2;                   // x 반폭
    const hh = (heightOffset * u);             // y 반높이 (= heightOffset * u)
    const hd = (40 * u) / 2;                   // z 반깊이
    const boxShape = new CANNON.Box(new CANNON.Vec3(hw, hh, hd));

    const spawnX = (Math.random() - 0.5) * 1600;
    const spawnZ = (Math.random() - 0.5) * 1600;
    const spawnY = 400 + Math.random() * 200;

    const body = new CANNON.Body({
        mass: 10,
        shape: boxShape,
        position: new CANNON.Vec3(spawnX, spawnY, spawnZ),
        material: state.animalMaterial || new CANNON.Material(),
        fixedRotation: true,        // 기울어지지 않게
        linearDamping: 0.95         // 미끄러짐 방지 (이동할 때만 속도 유지)
    });

    if (state.world) {
        state.world.addBody(body);
    }

    // Wandering speeds (1.5x 기본): 배회 이동 속도
    const speed = 300 + Math.random() * 300;

    const animGroup = ANIM_TYPE[type] || 'quadruped';

    const animalData = {
        mesh: animalGroup,
        body: body,
        state: 'falling',
        timer: 1.0,
        targetDir: new THREE.Vector3(),
        speed: speed,
        heightOffset: heightOffset,
        grabbed: false,
        // 애니메이션
        animalType: type,
        animGroup,
        animTime: 0,
        _animYOffset: 0,
        baseScale: animalGroup.scale.clone(),
        // 클릭 액션
        clickActionTimer: 0,
        clickActionPhase: 0,
        clickActionType: CLICK_ACTION_MAP[animGroup] || 'spin',
        clickBaseRotY: 0,
    };

    // 각 파트 mesh에 animalData 역참조 설정 (raycasting 식별용)
    animalGroup.children.forEach(child => {
        child.userData.animalRef = animalData;
    });

    animals.push(animalData);
}

function removeOldestAnimal() {
    const animal = animals.shift();
    if (animal) {
        if (animal.mesh) state.scene.remove(animal.mesh);
        if (animal.body && state.world) state.world.removeBody(animal.body);
    }
}

// 동물 전체 높이 (발바닥~머리, 월드 단위)
function getAnimalFullHeight(animal) {
    return animal.heightOffset * (voxelSize / 10); // halfHeight * 2
}

// 현재 서 있는 바닥 높이 (발 밑 기준으로 정확히 체크)
function getCurrentStandingGroundY(animal) {
    const body = animal.body;
    if (!body) return GROUND_BASE_HEIGHT;
    const halfHeight = animal.heightOffset * (voxelSize / 20);
    return getGroundHeightBelow(
        body.position.x,
        body.position.y + 0.5,
        body.position.z,
        GROUND_BASE_HEIGHT
    );
}

// 계단/복층/지붕을 고려해 배회 방향 선택. 경로가 유효하면 전진하도록 방향만 설정.
function pickWanderDirection(animal) {
    const body = animal.body;
    if (!body) return;

    const halfHeight = animal.heightOffset * (voxelSize / 20);
    const fullHeight = getAnimalFullHeight(animal);
    const currentGroundY = getCurrentStandingGroundY(animal);
    const maxStep = voxelSize * 1.5;
    const sampleDist = voxelSize * 3;
    const maxAttempts = 16;

    for (let i = 0; i < maxAttempts; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dirX = Math.sin(angle);
        const dirZ = Math.cos(angle);

        const sampleX = body.position.x + dirX * sampleDist;
        const sampleZ = body.position.z + dirZ * sampleDist;
        const sampleYStart = currentGroundY + fullHeight + 1;
        const newGroundY = getGroundHeightBelow(sampleX, sampleYStart, sampleZ, GROUND_BASE_HEIGHT);

        if (Math.abs(newGroundY - currentGroundY) > maxStep) continue;

        const ceilingY = getCeilingHeightAbove(sampleX, newGroundY + 0.1, sampleZ);
        const headroom = ceilingY - newGroundY;
        if (headroom < fullHeight * 0.95) continue;

        animal.targetDir.set(dirX, 0, dirZ).normalize();
        animal.state = 'walking';
        animal.timer = 2 + Math.random() * 5;
        return;
    }

    const angleFallback = Math.random() * Math.PI * 2;
    animal.targetDir.set(Math.sin(angleFallback), 0, Math.cos(angleFallback)).normalize();
    animal.state = 'walking';
    animal.timer = 1.0 + Math.random() * 2.0;
}

export function updateDogs(dt) {
    const boardLimit = 1000 - voxelSize * 2;

    animals.forEach(animal => {
        // 공통 애니메이션 시간 누적
        animal.animTime += dt;

        // ── 잡힌 상태: AI·물리 모두 정지 ──
        if (animal.grabbed) {
            if (animal.body) {
                animal.body.velocity.set(0, 0, 0);
                animal.body.angularVelocity.set(0, 0, 0);
            }
            return;
        }

        // ── 착지 감지: 현재 위치에서 아래로 레이 쏴 첫 블록 윗면에 안착 ──
        if (animal.state === 'falling') {
            if (animal.body) {
                const halfHeight = animal.heightOffset * (voxelSize / 20);
                const groundY = getGroundHeightBelow(
                    animal.body.position.x,
                    animal.body.position.y + 0.5,
                    animal.body.position.z,
                    GROUND_BASE_HEIGHT
                );
                const targetY = groundY + halfHeight;
                const distY = Math.abs(animal.body.position.y - targetY);

                if (Math.abs(animal.body.velocity.y) < 2.0 && distY < halfHeight * 0.4) {
                    animal.body.position.y = targetY;
                    animal.state = 'idle';
                    animal.timer = 0.3 + Math.random() * 0.7;
                }
            }
        } else {
            // ── 타이머 카운트다운 ──
            animal.timer -= dt;

            if (animal.timer <= 0) {
                if (animal.state === 'idle') {
                    // 휴식 끝 → 새 목적지로 이동 시작 (현재 층 기준으로 유효한 방향 선택)
                    pickWanderDirection(animal);
                } else {
                    // 이동 끝 → 짧은 휴식 후 다시 이동
                    animal.state = 'idle';
                    animal.timer = 0.5 + Math.random() * 1.5;
                }
            }
        }

        // ── 경계 반사 & 속도 적용. 경로가 유효하면 전진, 막히면 idle로 전환해 새 방향 선택 (제자리 회전 방지) ──
        if (animal.state === 'walking' && animal.body) {
            const predictX = animal.body.position.x + animal.targetDir.x * animal.speed * 0.5;
            const predictZ = animal.body.position.z + animal.targetDir.z * animal.speed * 0.5;
            const halfHeight = animal.heightOffset * (voxelSize / 20);
            const fullHeight = getAnimalFullHeight(animal);
            const currentGroundY = getCurrentStandingGroundY(animal);
            const nextGroundY = getGroundHeightBelow(predictX, currentGroundY + fullHeight, predictZ, GROUND_BASE_HEIGHT);
            const maxStep = voxelSize * 1.5;

            let blockForward = false;
            if (predictX > boardLimit || predictX < -boardLimit) blockForward = true;
            if (predictZ > boardLimit || predictZ < -boardLimit) blockForward = true;
            if (Math.abs(nextGroundY - currentGroundY) > maxStep) blockForward = true;
            const nextCeilingY = getCeilingHeightAbove(predictX, nextGroundY + 0.1, predictZ);
            if (nextCeilingY - nextGroundY < fullHeight * 0.95) blockForward = true;

            if (blockForward) {
                animal.state = 'idle';
                animal.timer = 0.2 + Math.random() * 0.3;
                animal.body.velocity.x = 0;
                animal.body.velocity.z = 0;
            } else {
                animal.body.velocity.x = animal.targetDir.x * animal.speed;
                animal.body.velocity.z = animal.targetDir.z * animal.speed;
                animal.mesh.rotation.y = Math.atan2(animal.targetDir.x, animal.targetDir.z);
            }
        } else if (animal.state === 'idle' && animal.body) {
            animal.body.velocity.x = 0;
            animal.body.velocity.z = 0;
        }

        // ── mesh 위치를 body에 동기화 ──
        if (animal.body) {
            animal.mesh.position.copy(animal.body.position);
            animal.mesh.position.y -= (animal.heightOffset * (voxelSize / 20));
        }

        // ── 이동 타입별 루프 애니메이션 (Math.sin 기반) ──
        const baseY = animal.mesh.position.y;
        const t = animal.animTime;
        const baseScale = animal.baseScale;

        let yOffset = 0;
        let sideTilt = 0;

        switch (animal.animGroup) {
            case 'quadruped':
                // 살짝 상하 바운스 + 좌우 기울기
                yOffset = Math.sin(t * 8) * 4;
                sideTilt = Math.sin(t * 6) * 0.08;
                break;
            case 'waddling':
                // 뒤뚱거림: 좌우 롤 중심
                sideTilt = Math.sin(t * 4) * 0.25;
                break;
            case 'hopping':
                // 토끼: 걷는 동안만 통통 튀는 점프
                if (animal.state === 'walking') {
                    const hop = Math.abs(Math.sin(t * 6));
                    yOffset = hop * 18;
                }
                break;
            case 'sliding':
                // 슬라이딩: 거의 붙어서 살짝 흔들림만
                yOffset = Math.sin(t * 3) * 2;
                break;
            case 'special':
                // 특수: 살짝 떠오르며 회전
                yOffset = Math.sin(t * 2) * 6;
                animal.mesh.rotation.y += dt * 0.6;
                break;
        }

        animal.mesh.position.y = baseY + yOffset;
        if (sideTilt !== 0) {
            animal.mesh.rotation.z = sideTilt;
        }

        // ── 클릭 액션 오버레이 ──
        if (animal.clickActionTimer > 0) {
            animal.clickActionTimer -= dt;
            const duration = 0.75;
            const remaining = Math.max(animal.clickActionTimer, 0);
            const progress = 1 - remaining / duration; // 0 → 1

            switch (animal.clickActionType) {
                case 'spin': {
                    // 제자리 회전 (한 바퀴)
                    if (animal.clickActionPhase === 0) {
                        animal.clickBaseRotY = animal.mesh.rotation.y;
                        animal.clickActionPhase = 1;
                    }
                    animal.mesh.rotation.y = animal.clickBaseRotY + progress * Math.PI * 2;
                    break;
                }
                case 'scale': {
                    // 통통 튀는 확대/축소
                    const s = 1 + Math.sin(progress * Math.PI) * 0.4;
                    animal.mesh.scale.set(
                        baseScale.x * s,
                        baseScale.y * s,
                        baseScale.z * s,
                    );
                    break;
                }
                case 'jump': {
                    // 위로 한 번 점프
                    if (animal.clickActionPhase === 0) {
                        animal.clickActionPhase = 1;
                        if (animal.body) {
                            animal.body.velocity.y = 350;
                        }
                    }
                    break;
                }
                case 'squash': {
                    // 아래로 눌렸다가 복원
                    const squash = 1 + Math.sin(progress * Math.PI) * 0.3;
                    animal.mesh.scale.set(
                        baseScale.x * squash,
                        baseScale.y / squash,
                        baseScale.z * squash,
                    );
                    break;
                }
                case 'pulse': {
                    // 작게 펄스
                    const p = 1 + Math.sin(progress * Math.PI * 2) * 0.25;
                    animal.mesh.scale.set(
                        baseScale.x * p,
                        baseScale.y * p,
                        baseScale.z * p,
                    );
                    break;
                }
            }

            if (animal.clickActionTimer <= 0) {
                animal.clickActionTimer = 0;
                animal.clickActionPhase = 0;
                // 스케일/회전 원복
                animal.mesh.scale.copy(baseScale);
            }
        } else {
            // 클릭 액션이 없을 때는 기본 스케일 유지
            animal.mesh.scale.copy(baseScale);
        }
    });
}
