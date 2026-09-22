import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, voxelSize, objects } from './state.js';
import { explodeBlockHeavy, pushHistory } from './scene.js';
import { foods } from './food.js';
import { playSound } from './sound.js';
import { applySnack, clearMagicEffect } from './magic.js';
import { detachTrainFollower } from './train.js';
import { createSoftBoxGeometry, mergeStaticParts } from './model-utils.js';
import { ANIMAL_CATEGORIES, ANIMAL_NAMES } from './animal-catalog.js';
import { triggerAnimalPower, updateAnimalPowers, clearAnimalPower, getAnimalPowerInfo } from './animal-powers.js';

export const animals = [];
export const dogs = animals; // Aliased for backwards compatibility in main.js
export const MAX_ANIMALS = 20;

export const GROUP_ANIMALS = {
    quad:       ['dog','cat','sheep','pig','giraffe','otter'],
    hop:        ['rabbit','pikachu','eevee','frog','kangaroo','baby-dragon'],
    sneak:      ['snake','turtle','snail','crocodile','hedgehog'],
    heavy:      ['snorlax','elephant'],
    waddle:     ['penguin','jigglypuff','octopus','crab','panda'],
    special:    ['ditto'],
    carnivore:  ['lion','crocodile'],
    ...Object.fromEntries(ANIMAL_CATEGORIES.map(category => [category.id, category.types])),
};

const GROUND_BASE_HEIGHT = 0;
const EAT_RADIUS = voxelSize * 1.8;

export let grabbedAnimal = null;
export function setGrabbedAnimal(a) {
    if (a) { detachTrainFollower(a); clearAnimalPower(a); }
    grabbedAnimal = a;
}

export function disposeAnimalMesh(mesh) {
    if (!mesh) return;
    mesh.removeFromParent();
    const geometries = new Set();
    const materials = new Set();
    mesh.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) {
            const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
            childMaterials.forEach(material => materials.add(material));
        }
        delete child.userData.animalRef;
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
}

function detachAnimalBody(animal) {
    detachTrainFollower(animal);
    clearAnimalPower(animal);
    clearMagicEffect(animal);
    if (animal.body && state.world) state.world.removeBody(animal.body);
    animal.grabbed = false;
    if (grabbedAnimal === animal) grabbedAnimal = null;
}

export function clearAllAnimals() {
    while (animals.length > 0) {
        const animal = animals.pop();
        detachAnimalBody(animal);
        disposeAnimalMesh(animal.mesh);
    }
    grabbedAnimal = null;
}

// ── 개별 제거: "뿅" 스케일 팝 → 축소 → 삭제 ──
export function removeAnimalWithEffect(animal) {
    const idx = animals.indexOf(animal);
    if (idx === -1) return;
    animals.splice(idx, 1);
    detachAnimalBody(animal);
    if (animal.livingId) pushHistory();
    playSound('animal-remove');

    let t = 0;
    const mesh = animal.mesh;
    if (!mesh) return;

    function poof() {
        t += 0.13;
        if (t < 0.25) {
            const s = 1 + t * 1.8;
            mesh.scale.set(s, s, s);
            requestAnimationFrame(poof);
        } else {
            const s = Math.max(0, 1.45 - (t - 0.25) * 4.8);
            mesh.scale.set(s, s, s);
            if (s > 0.01) {
                requestAnimationFrame(poof);
            } else {
                disposeAnimalMesh(mesh);
            }
        }
    }
    poof();
}

// ── 연기 파티클 헬퍼 ──
function _createSmokePoof(position) {
    const geo = createSoftBoxGeometry(voxelSize * 0.48, voxelSize * 0.48, voxelSize * 0.38, voxelSize * 0.1);
    const particles = [];
    for (let i = 0; i < 10; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: [0xffe9c8, 0xd9ecf5, 0xf0ddef][i % 3], transparent: true, opacity: 0.85 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(position);
        state.scene.add(mesh);
        particles.push({
            mesh,
            vel: new THREE.Vector3(
                (Math.random() - 0.5) * 200,
                Math.random() * 200 + 60,
                (Math.random() - 0.5) * 200
            ),
            life: 1.0
        });
    }
    function animateSmoke() {
        let alive = false;
        for (const p of particles) {
            if (p.life <= 0) continue;
            p.life -= 0.034;
            if (p.life <= 0) {
                p.mesh.removeFromParent();
                p.mesh.material.dispose();
                continue;
            }
            alive = true;
            p.mesh.position.addScaledVector(p.vel, 0.016);
            p.vel.y -= 55 * 0.016;
            const s = p.life * 2.6;
            p.mesh.scale.set(s, s, s);
            p.mesh.material.opacity = p.life * 0.8;
        }
        if (alive) requestAnimationFrame(animateSmoke);
        else geo.dispose();
    }
    animateSmoke();
}

// ── 전체 제거: 연기 파티클 + 축소 애니메이션 ──
export function removeAllAnimalsWithEffect() {
    const toRemove = [...animals];
    animals.length = 0;
    grabbedAnimal = null;
    if (toRemove.some(animal => animal.livingId)) pushHistory();

    toRemove.forEach(animal => {
        detachAnimalBody(animal);
        const mesh = animal.mesh;
        if (!mesh) return;

        _createSmokePoof(mesh.position.clone());

        let t = 0;
        function shrink() {
            t += 0.14;
            const s = Math.max(0, 1 - t);
            mesh.scale.set(s, s, s);
            if (s > 0.01) {
                requestAnimationFrame(shrink);
            } else {
                disposeAnimalMesh(mesh);
            }
        }
        shrink();
    });
}

// ── 지형/천장 계산용 Raycaster ──
const _groundRaycaster = new THREE.Raycaster();
const _groundRayDown = new THREE.Vector3(0, -1, 0);
const _groundRayUp = new THREE.Vector3(0, 1, 0);
const MAX_GROUND_CHECK_HEIGHT = 5000;
const RAY_ORIGIN = new THREE.Vector3();

// ── 전방 장애물 감지용 Raycaster ──
const _aimRay = new THREE.Raycaster();
const _aimOrigin = new THREE.Vector3();
const _thicknessCheck = new THREE.Vector3();

function getBlockObjects() {
    return objects.filter(o => o !== state.plane);
}

export function getGroundHeightBelow(x, yStart, z, defaultY = GROUND_BASE_HEIGHT) {
    if (objects.length === 0) return defaultY;
    RAY_ORIGIN.set(x, yStart, z);
    _groundRaycaster.set(RAY_ORIGIN, _groundRayDown);
    const hits = _groundRaycaster.intersectObjects(objects, true);
    if (hits.length > 0) return hits[0].point.y;
    return defaultY;
}

export function getCeilingHeightAbove(x, yStart, z) {
    const blockObjects = getBlockObjects();
    if (blockObjects.length === 0) return Infinity;
    RAY_ORIGIN.set(x, yStart, z);
    _groundRaycaster.set(RAY_ORIGIN, _groundRayUp);
    const hits = _groundRaycaster.intersectObjects(blockObjects, false);
    if (hits.length > 0) return hits[0].point.y;
    return Infinity;
}

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
    animal.body.velocity.set(0, 0, 0);
    animal.body.aabbNeedsUpdate = true;
    animal.mesh.position.copy(animal.body.position);
    animal.mesh.position.y -= halfHeight;
}

// ── 전방 장애물 감지 ──
// 발 높이 + 중간 높이 두 개의 레이를 쏴서 블록 히트를 반환
function probeAhead(animalPos, direction, groundY, halfHeight) {
    const blockObjects = getBlockObjects();
    if (blockObjects.length === 0) return null;
    const PROBE_DIST = voxelSize * 3.5;
    // 발 높이 레이 (블록 하단부 감지)
    _aimOrigin.set(animalPos.x, groundY + 2, animalPos.z);
    _aimRay.set(_aimOrigin, direction);
    const hitsLow = _aimRay.intersectObjects(blockObjects, false);
    if (hitsLow.length > 0 && hitsLow[0].distance < PROBE_DIST) return hitsLow[0];
    // 중간 높이 레이 (블록 상단부 감지)
    _aimOrigin.set(animalPos.x, groundY + halfHeight * 1.5 + 1, animalPos.z);
    _aimRay.set(_aimOrigin, direction);
    const hitsMid = _aimRay.intersectObjects(blockObjects, false);
    if (hitsMid.length > 0 && hitsMid[0].distance < PROBE_DIST) return hitsMid[0];
    return null;
}

// ── 벽 스택 최상단 Y 반환 (SNEAK 등반 목표 계산) ──
function getWallTopY(hitPoint, direction) {
    const blockObjects = getBlockObjects();
    const checkX = hitPoint.x + direction.x * voxelSize * 0.4;
    const checkZ = hitPoint.z + direction.z * voxelSize * 0.4;
    let topY = hitPoint.y;
    for (const obj of blockObjects) {
        const dx = Math.abs(obj.position.x - checkX);
        const dz = Math.abs(obj.position.z - checkZ);
        if (dx < voxelSize * 0.65 && dz < voxelSize * 0.65) {
            const top = obj.position.y + voxelSize * 0.5;
            if (top > topY) topY = top;
        }
    }
    return topY;
}

// ── 특정 XYZ 근처 블록 반환 (HEAVY 다단 파괴용) ──
function findBlockAtPos(x, y, z) {
    const blockObjects = getBlockObjects();
    return blockObjects.find(obj =>
        Math.abs(obj.position.x - x) < voxelSize * 0.6 &&
        Math.abs(obj.position.y - y) < voxelSize * 0.6 &&
        Math.abs(obj.position.z - z) < voxelSize * 0.6
    ) || null;
}

// ── 벽 두께 측정 (히트 포인트에서 direction 방향으로 연속 블록 수 카운트) ──
function countThickness(firstHit, direction) {
    const blockObjects = getBlockObjects();
    if (blockObjects.length === 0) return 1;
    let count = 1;
    // 첫 히트 블록을 지나쳐 연속된 블록을 단계적으로 확인
    // 다섯 번째 블록까지 확인해야 4블록 제한을 실제로 판별할 수 있다.
    for (let step = 1; step <= 4; step++) {
        _thicknessCheck.copy(firstHit.point).addScaledVector(direction, voxelSize * step + 0.1);
        const found = blockObjects.some(obj => {
            return Math.abs(obj.position.x - _thicknessCheck.x) <= voxelSize * 0.5 &&
                Math.abs(obj.position.y - _thicknessCheck.y) <= voxelSize * 0.5 &&
                Math.abs(obj.position.z - _thicknessCheck.z) <= voxelSize * 0.5;
        });
        if (found) count++;
        else break;
    }
    return count;
}

// ── 장애물 우회 방향 탐색 (±30°~±150° 순서로 시도) ──
function steerAround(animalPos, desiredDir, groundY, halfHeight) {
    const angles = [
        Math.PI / 6, -Math.PI / 6,
        Math.PI / 3, -Math.PI / 3,
        Math.PI / 2, -Math.PI / 2,
        2 * Math.PI / 3, -2 * Math.PI / 3,
    ];
    for (const angle of angles) {
        const c = Math.cos(angle), s = Math.sin(angle);
        const tryDir = new THREE.Vector3(
            desiredDir.x * c - desiredDir.z * s,
            0,
            desiredDir.x * s + desiredDir.z * c
        ).normalize();
        if (!probeAhead(animalPos, tryDir, groundY, halfHeight)) return tryDir;
    }
    return null;
}

// ── 가장 가까운 먹이 찾기 (도달 가능 높이 필터 포함) ──
function findNearestFood(animal) {
    // Floating friends cannot reach floor snacks; chasing them would keep
    // reversing direction directly above the food. Direct feeding stays in input.js.
    if (foods.length === 0 || !animal.body || animal.magicEffect?.ingredients.includes('balloon')) return null;
    let nearest = null;
    let minDist = Infinity;

    const animalGroundY = getGroundHeightBelow(
        animal.body.position.x, animal.body.position.y + 0.5, animal.body.position.z, GROUND_BASE_HEIGHT
    );

    // 타입별 도달 가능 최대 높이 (지면 기준)
    let maxReach;
    if (animal.animGroup === 'SNEAK') {
        maxReach = voxelSize * 20;    // 벽 타기 가능 — 매우 높이까지
    } else if (animal.animGroup === 'HOP') {
        maxReach = voxelSize * 5;     // 점프 — 약 5블록
    } else {
        maxReach = voxelSize * 2;     // 나머지 — 약 2블록 단차
    }

    for (const food of foods) {
        if (food.eaten || food.consumeTimer > 0 || food.carriedBy) continue;
        if (food.falling) continue; // 낙하 중인 사과는 타겟 불가 (착지 후 재인식)
        const heightAboveGround = food.position.y - animalGroundY;
        // 너무 높아서 도달 불가능한 사과 제외
        if (heightAboveGround > maxReach) continue;

        const dx = food.position.x - animal.body.position.x;
        const dz = food.position.z - animal.body.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDist) { minDist = dist; nearest = food; }
    }
    return nearest;
}

function canReachFood(animal, food) {
    _aimOrigin.copy(animal.body.position);
    const direction = food.position.clone();
    direction.y += voxelSize * 0.24;
    direction.sub(_aimOrigin);
    const distance = direction.length();
    if (distance < 0.001) return true;
    _aimRay.set(_aimOrigin, direction.normalize());
    const hits = _aimRay.intersectObjects(getBlockObjects(), false);
    return hits.length === 0 || hits[0].distance >= distance;
}

// ── 애니메이션 그룹 매핑 ──
const ANIM_TYPE = {};
[
    ['WADDLE',    ['penguin', 'jigglypuff', 'octopus', 'crab', 'panda']],
    ['HOP',       ['rabbit', 'pikachu', 'eevee', 'frog', 'kangaroo', 'baby-dragon']],
    ['SNEAK',     ['snake', 'turtle', 'snail', 'crocodile', 'hedgehog']],
    ['HEAVY',     ['snorlax', 'elephant']],
    ['quadruped', ['dog', 'cat', 'sheep', 'pig', 'giraffe', 'otter']],
    ['CARNIVORE', ['lion']],
    ['special',   ['ditto']],
].forEach(([grp, list]) => list.forEach(name => { ANIM_TYPE[name] = grp; }));

const CLICK_ACTION_MAP = {
    WADDLE:    'waddleSpin',
    HOP:       'aerialSpin',
    SNEAK:     'dash',
    HEAVY:     'groundShake',
    quadruped: 'spin',
    CARNIVORE: 'spin',
    special:   'pulse',
};

const CLICK_ACTION_OVERRIDES = {
    sheep: 'squash', pig: 'squash', snorlax: 'squash', ditto: 'squash', turtle: 'spin'
};
const CLICK_ACTION_INFO = {
    waddleSpin: { name: '뒤뚱뒤뚱 댄스', description: '톡 누르면 몸을 흔들며 한 바퀴 춤춰요.' },
    aerialSpin: { name: '공중 빙글 점프', description: '톡 누르면 폴짝 뛰어올라 공중에서 빙글 돌아요.' },
    dash: { name: '쌩쌩 대시', description: '톡 누르면 바라보는 쪽으로 짧게 달려요.' },
    groundShake: { name: '쿵쿵 발구르기', description: '톡 누르면 발을 굴러 땅을 살짝 흔들어요.' },
    spin: { name: '빙글빙글 팽이', description: '톡 누르면 제자리에서 귀엽게 한 바퀴 돌아요.' },
    squash: { name: '말랑말랑 변신', description: '톡 누르면 납작해졌다가 원래 모습으로 통통 돌아와요.' },
    pulse: { name: '두근두근 부풀기', description: '톡 누르면 몸이 커졌다 작아졌다 해요.' }
};

const ACTION_DURATION = {
    waddleSpin:  1.0,
    aerialSpin:  0.8,
    dash:        0.5,
    groundShake: 0.6,
    spin:        0.75,
    squash:      0.75,
    pulse:       0.75,
};

const SPEED_MULT = {
    HEAVY:     0.35,
    WADDLE:    0.65,
    SNEAK:     1.1,
    HOP:       1.25,
    quadruped: 1.0,
    CARNIVORE: 1.3,
    special:   0.9,
};

const FLEE_RADIUS = voxelSize * 6;
const MAX_CARNIVORES = 4;

export function triggerClickAction(animal) {
    if (!animals.includes(animal) || animal.grabbed || animal.trainRide) return;
    if (triggerAnimalPower(animal, animals) || animal.clickActionTimer > 0) return;
    const actionType = CLICK_ACTION_OVERRIDES[animal.animalType] || CLICK_ACTION_MAP[animal.animGroup] || 'spin';
    animal.clickActionTimer = ACTION_DURATION[actionType] || 0.75;
    playSound('animal-click-' + animal.animGroup);
    animal.clickActionPhase = 0;
    animal.clickActionType = actionType;
    state.onToyNotice?.(`${animal.displayName || '블록 친구'} · ${animal.abilityName || CLICK_ACTION_INFO[actionType].name}`);
}

const ANIMAL_PALETTES = [
    [0xe9bc8c, 0xffe7c2, 0xb87b60], [0xa7cfdf, 0xe1f3f5, 0x7395c4],
    [0xd1b6e5, 0xf2e5f9, 0x9a80b9], [0xb7d7ac, 0xebf4d5, 0x7eac85],
    [0xf0b6b9, 0xffe5dc, 0xcb8499]
];

export function spawnDog(group = 'all') {
    if (animals.length >= MAX_ANIMALS) {
        state.onToyNotice?.(`동물 상한선에 도달했어요! 최대 ${MAX_ANIMALS}마리까지 함께 놀 수 있어요. 🐾`);
        return null;
    }
    let pool = GROUP_ANIMALS[group] || GROUP_ANIMALS.all;
    const carnivoreCount = animals.filter(a => a.isCarnivore).length;
    if (carnivoreCount >= MAX_CARNIVORES) {
        // 육식동물 전용 버튼으로 호출 시 → 상한선 도달이면 생성 자체 중단
        if (group === 'carnivore') return;
        // 랜덤/다른 그룹 → 풀에서 육식동물만 제외하고 계속 진행
        pool = pool.filter(t => !GROUP_ANIMALS.carnivore.includes(t));
        if (pool.length === 0) pool = GROUP_ANIMALS.all.filter(t => !GROUP_ANIMALS.carnivore.includes(t));
    }
    const type = pool[Math.floor(Math.random() * pool.length)];

    const animalGroup = new THREE.Group();
    const u = voxelSize / 25;

    const [baseColor, secondaryColor, accentColor] = ANIMAL_PALETTES[Math.floor(Math.random() * ANIMAL_PALETTES.length)];

    const matBase = new THREE.MeshPhysicalMaterial({ color: baseColor, roughness: 0.8 });
    const matSec  = new THREE.MeshPhysicalMaterial({ color: secondaryColor, roughness: 0.8 });
    const matAcc  = new THREE.MeshPhysicalMaterial({ color: accentColor, roughness: 0.8 });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x283044, roughness: 0.8 });
    const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xfff9ee, roughness: 0.8 });

    function addPart(w, h, d, x, y, z, mat = matBase, corner = Math.min(w, h) * 0.12) {
        const geo = createSoftBoxGeometry(w * u, h * u, d * u, corner * u);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x * u, y * u, z * u);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isAnimalPart = true;
        animalGroup.add(mesh);
        return mesh;
    }

    function addSoftPart(w, h, d, x, y, z, mat = matBase, corner = 1) {
        return addPart(w, h, d, x, y, z, mat, corner);
    }

    let heightOffset = 20;

    if (type === 'dog') {
        heightOffset = 20;
        addSoftPart(20, 16, 32, 0, 16, 0, matBase, 2);
        addSoftPart(18, 17, 16, 0, 32, 24, matBase, 2);
        addSoftPart(12, 7, 8, 0, 28, 35, matSec);
        addSoftPart(5, 3, 2, 0, 30, 39.5, blackMat, 0.5);
        addPart(5, 1, 0.6, 0, 26.5, 39.3, blackMat);
        for (const side of [-1, 1]) {
            addPart(3, 3, 1.5, side * 5, 35, 32.5, blackMat);
            addPart(1, 1, 0.5, side * 5 - 0.5, 35.7, 33.4, whiteMat);
            addSoftPart(6, 15, 6, side * 9, 36.5, 23, matSec, 2);
            for (const z of [-10, 10]) {
                addPart(6, 10, 6, side * 6, 7, z);
                addSoftPart(7, 4, 8, side * 6, 2, z + 1, matSec);
            }
        }
        addPart(12, 3, 4, 0, 23, 16, matAcc);
        const tail = addSoftPart(5, 15, 5, 0, 28, -18, matBase, 1.5); tail.rotation.x = -Math.PI / 4;
    } else if (type === 'cat') {
        heightOffset = 16;
        addSoftPart(16, 12, 24, 0, 12, 0, matBase, 2);
        addSoftPart(15, 13, 12, 0, 24, 18, matBase, 1.5);
        addSoftPart(9, 4, 2, 0, 21.5, 24, whiteMat);
        addPart(2, 1.5, 1, 0, 23, 25.5, matAcc);
        addPart(1, 2, 0.5, 0, 21.5, 25.3, blackMat);
        for (const side of [-1, 1]) {
            addPart(3, 3, 1, side * 4.5, 26, 24.5, blackMat);
            addPart(1, 1, 0.5, side * 4.5 - 0.5, 26.6, 25.2, whiteMat);
            addSoftPart(5, 8, 5, side * 5, 32.5, 18, matBase, 1.5);
            addPart(2, 3, 0.8, side * 5, 32, 20.4, matAcc);
            addPart(4, 0.8, 0.8, side * 7, 22, 24.5, matSec);
            for (const z of [-8, 8]) {
                addPart(4, 6, 4, side * 4.5, 5, z);
                addSoftPart(5, 3, 6, side * 4.5, 1.5, z + 1, whiteMat, 0.5);
            }
        }
        addPart(3, 14, 3, 0, 21, -13, matBase);
        addSoftPart(3, 6, 7, 0, 29, -15, matSec, 1);
    } else if (type === 'rabbit') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xf6b1c5, roughness: 0.8 });
        addSoftPart(14, 12, 18, 0, 10, 0, whiteMat, 2);
        addSoftPart(13, 12, 12, 0, 20, 9.5, whiteMat, 2.5);
        addSoftPart(7, 3, 2, 0, 17.5, 15.5, whiteMat, 0.5);
        addPart(2, 1.5, 1, 0, 19, 17, pink);
        addPart(1, 1.5, 0.5, 0, 17.5, 16.8, blackMat);
        for (const side of [-1, 1]) {
            addPart(2.5, 3, 1, side * 3.5, 22, 15.8, blackMat);
            addPart(0.8, 0.8, 0.4, side * 3.5 - 0.4, 22.7, 16.5, whiteMat);
            addSoftPart(4, 15, 4, side * 3.5, 32, 11, whiteMat, 1);
            addSoftPart(2, 11, 0.8, side * 3.5, 32, 13.2, pink, 0.5);
            addSoftPart(4, 6, 5, side * 4, 3, 7, whiteMat);
            addSoftPart(7, 8, 11, side * 4, 4, -3, whiteMat, 2.5);
        }
        addSoftPart(7, 7, 7, 0, 12, -11, whiteMat, 2);
    } else if (type === 'sheep') {
        heightOffset = 20;
        addSoftPart(26, 22, 30, 0, 19, 0, whiteMat, 5);
        addSoftPart(13, 13, 16, 0, 28, 22, blackMat, 2);
        addSoftPart(14, 6, 12, 0, 35, 21, whiteMat, 2);
        addPart(3, 1, 0.6, 0, 24, 30.3, matSec);
        for (const side of [-1, 1]) {
            addPart(3.5, 4, 1, side * 4, 30, 30.3, whiteMat);
            addPart(1.5, 2, 0.7, side * 4, 29.8, 31.1, blackMat);
            addSoftPart(7, 4, 6, side * 8, 29, 22, blackMat);
            for (const z of [-10, 10]) {
                addSoftPart(5, 10, 5, side * 6, 5, z, blackMat, 1.5);
            }
        }
        addSoftPart(6, 6, 7, 0, 19, -16, whiteMat, 1.5);
    } else if (type === 'snake') {
        heightOffset = 6;
        addSoftPart(9, 6, 42, 0, 3, 3, matBase, 2.5);
        addSoftPart(5, 4, 14, -1, 2, -22, matBase, 1.5);
        addSoftPart(12, 9, 13, 0, 5, 29.5, matBase, 2);
        addSoftPart(10, 3, 9, 0, 2, 33, matSec, 1);
        for (const side of [-1, 1]) {
            addSoftPart(3, 3.5, 0.7, side * 3.5, 7, 36.1, whiteMat, 0.7);
            addPart(2, 2.5, 0.5, side * 3.5, 7.1, 36.6, blackMat);
            addPart(0.7, 0.7, 0.3, side * 3.5 - 0.3, 7.7, 37.05, whiteMat);
        }
        addPart(5, 0.8, 0.5, 0, 3, 37.8, blackMat);
        addPart(2, 0.8, 4, 0, 2.5, 39, matAcc);
    } else if (type === 'pikachu') {
        heightOffset = 16;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd83d, roughness: 0.7 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xf35748, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x99643c, roughness: 0.8 });
        addSoftPart(16, 19, 15, 0, 13.5, 0, yellow, 2);
        addSoftPart(19, 17, 16, 0, 29, 4, yellow, 2);
        for (const side of [-1, 1]) {
            addPart(3, 3.5, 1.5, side * 5.5, 30, 12.4, blackMat);
            addPart(1, 1, 0.5, side * 5.5 - 0.5, 30.8, 13.4, whiteMat);
            addSoftPart(4, 4, 1.5, side * 7, 26.5, 12.5, red, 0.5);
            const ear = addSoftPart(4.5, 14, 4, side * 7.5, 42, 3.5, yellow, 1.5);
            ear.rotation.z = -side * 0.16;
            const tip = addSoftPart(4.5, 6, 4, side * 8.6, 49, 3.5, blackMat, 1.5);
            tip.rotation.z = -side * 0.16;
            addSoftPart(4.5, 8, 5, side * 8.5, 14, 7, yellow, 0.8);
            addSoftPart(6, 4, 9, side * 5, 2, 4, yellow, 0.8);
            addPart(2, 0.7, 0.5, side * 1.2, 25.2, 12.3, blackMat);
            addPart(0.7, 1.2, 0.5, side * 2.4, 25.7, 12.3, blackMat);
        }
        addPart(1.2, 0.8, 0.7, 0, 28, 12.6, blackMat);
        addPart(10, 2, 0.8, 0, 15, -7.8, brown);
        addPart(9, 2, 0.8, 0, 20, -7.8, brown);
        // A connected, two-bend lightning silhouette stays readable behind the body.
        addPart(4, 8, 4, 1, 10, -9, brown);
        addPart(8, 4, 4, 3, 15, -11, brown);
        addPart(5, 10, 4, 7, 20, -11, yellow);
        addPart(9, 5, 4, 10, 25, -11, yellow);
        addPart(8, 12, 4, 12, 32, -11, yellow);
    } else if (type === 'snorlax') {
        heightOffset = 24;
        const teal = new THREE.MeshPhysicalMaterial({ color: 0x478d95, roughness: 0.8 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xffedc7, roughness: 0.8 });
        const pad = new THREE.MeshPhysicalMaterial({ color: 0xbc9065, roughness: 0.8 });
        addSoftPart(42, 36, 32, 0, 21, 0, teal, 7);
        addSoftPart(32, 27, 1.2, 0, 20, 16, cream, 7);
        addSoftPart(30, 24, 24, 0, 44, 3, teal, 5);
        addSoftPart(24, 16, 1, 0, 44, 15, cream, 4);
        addPart(5, 0.9, 0.4, 0, 41, 15.7, blackMat);
        for (const side of [-1, 1]) {
            addPart(5, 1.2, 0.4, side * 6.5, 46.5, 15.7, blackMat);
            addSoftPart(7, 7, 7, side * 10.5, 55, 0, teal, 2.5);
            const arm = addSoftPart(12, 18, 12, side * 23, 24, 3, teal, 4);
            arm.rotation.z = side * 0.12;
            addSoftPart(13, 8, 15, side * 12, 4, 12.5, cream, 3);
            addSoftPart(7, 4, 0.7, side * 12, 4, 20, pad, 1.8);
        }
    } else if (type === 'jigglypuff') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffb9d0, roughness: 0.75 });
        const rose = new THREE.MeshPhysicalMaterial({ color: 0xe887aa, roughness: 0.8 });
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x499eb9, roughness: 0.8 });
        addSoftPart(24, 24, 24, 0, 14, 0, pink, 4);
        for (const side of [-1, 1]) {
            addSoftPart(6, 7, 0.7, side * 6, 16, 12.1, whiteMat, 2);
            addSoftPart(4.5, 5.5, 0.5, side * 6, 16, 12.5, blue, 1.5);
            addPart(2.5, 3.5, 0.3, side * 6, 16.3, 12.8, blackMat);
            addPart(1.4, 1.4, 0.3, side * 6 - 0.7, 17.4, 13.05, whiteMat);
            addSoftPart(6, 8, 6, side * 8, 28, 0, pink, 2);
            addPart(3, 4, 0.7, side * 8, 28.5, 3.4, rose);
            addSoftPart(6, 6, 6, side * 12, 13, 4, pink, 1.5);
            addSoftPart(8, 4, 10, side * 6, 2, 8, pink, 1.5);
            addPart(3, 1.5, 0.7, side * 9, 11, 12.4, rose);
        }
        addSoftPart(9, 7, 6, 1, 27, 8, pink, 2.5);
        addPart(3, 1, 0.6, 0, 9, 12.4, blackMat);
        addPart(1, 1, 0.6, -2, 10, 12.4, blackMat);
        addPart(1, 1, 0.6, 2, 10, 12.4, blackMat);
    } else if (type === 'ditto') {
        heightOffset = 8;
        const purple = new THREE.MeshPhysicalMaterial({ color: 0xd9afe7, roughness: 0.5, transmission: 0.15 });
        const blush = new THREE.MeshPhysicalMaterial({ color: 0xe7a0d0, roughness: 0.7 });
        addSoftPart(24, 20, 20, 0, 10, 0, purple, 5);
        for (const side of [-1, 1]) {
            addPart(2, 2, 0.7, side * 4.5, 16, 10, blackMat);
            addPart(0.6, 0.6, 0.3, side * 4.5 - 0.3, 16.4, 10.5, whiteMat);
            addPart(3, 1.2, 0.5, side * 7, 14, 10, blush);
            addSoftPart(8, 7, 9, side * 11, 10, 3, purple, 3);
            addPart(1, 1.5, 0.5, side * 3, 14, 10, blackMat);
        }
        addPart(5, 1, 0.5, 0, 13.5, 10, blackMat);
    } else if (type === 'lion') {
        heightOffset = 24;
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xe9b34e, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x9d572f, roughness: 0.9 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xffdf9b, roughness: 0.8 });
        addSoftPart(22, 21, 34, 0, 23, 0, gold, 3);
        addSoftPart(29, 29, 14, 0, 31, 20, brown, 5);
        addSoftPart(20, 19, 16, 0, 32, 28, gold, 3);
        addSoftPart(10, 6, 4, 0, 28, 37, cream, 1);
        addPart(3, 2, 1, 0, 30, 39.5, blackMat);
        addPart(4, 0.7, 0.6, 0, 26.8, 39.3, brown);
        for (const side of [-1, 1]) {
            addSoftPart(6, 6, 5, side * 9, 42, 25, gold, 1);
            addPart(3, 3, 0.8, side * 9, 42, 28, cream);
            addPart(3, 4, 1, side * 5, 35, 36.5, blackMat);
            addPart(1, 1.3, 0.5, side * 5 - 0.5, 35.9, 37.3, whiteMat);
            for (const z of [-14, 14]) {
                addSoftPart(7, 16, 7, side * 7, 8, z, gold, 2);
                addSoftPart(8, 4, 9, side * 7, 2, z + 1, cream, 1.5);
            }
        }
        addPart(3, 3, 12, 0, 24, -22, gold);
        addPart(3, 9, 3, 0, 28, -27, gold);
        addSoftPart(6, 7, 6, 0, 34, -27, brown, 1);
    } else if (type === 'elephant') {
        heightOffset = 36;
        const grey = new THREE.MeshPhysicalMaterial({ color: 0x939eae, roughness: 0.8 });
        const light = new THREE.MeshPhysicalMaterial({ color: 0xb5bec9, roughness: 0.8 });
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xd8b8bb, roughness: 0.8 });
        addSoftPart(36, 32, 48, 0, 32, 0, grey, 4);
        addSoftPart(28, 28, 28, 0, 40, 32, grey, 3);
        for (const side of [-1, 1]) {
            addSoftPart(21, 28, 8, side * 23, 37, 28, grey, 6);
            addSoftPart(13, 19, 1, side * 24, 37, 32.2, pink, 4);
            addPart(3.5, 4.5, 1, side * 9, 44, 46.5, blackMat);
            addPart(1.2, 1.4, 0.5, side * 9 - 0.6, 45, 47.3, whiteMat);
            for (const z of [-16, 16]) {
                addSoftPart(12, 20, 12, side * 12, 10, z, grey, 3);
                addSoftPart(8, 3, 0.6, side * 12, 2, z + 6.1, light, 1);
            }
        }
        addSoftPart(10, 26, 10, 0, 27, 47, grey, 3);
        addSoftPart(9, 9, 14, 0, 16, 51, grey, 3);
        addSoftPart(7, 11, 7, 0, 19, 56, grey, 2.5);
        addPart(3, 12, 3, 0, 26, -25, grey);
        addSoftPart(5, 5, 4, 0, 19, -25, light, 1);
    } else if (type === 'giraffe') {
        heightOffset = 60;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xf6c65d, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0xa76838, roughness: 0.9 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xffe4a6, roughness: 0.8 });
        addSoftPart(20, 20, 32, 0, 40, 0, yellow, 2);
        addSoftPart(8, 40, 12, 0, 64, 20, yellow, 1);
        addSoftPart(12, 12, 20, 0, 84, 28, yellow, 2);
        addSoftPart(12, 6, 6, 0, 81, 38, cream, 1);
        addPart(4, 0.7, 0.5, 0, 80, 41.4, brown);
        for (const side of [-1, 1]) {
            addPart(2.5, 3.5, 1, side * 4, 87, 38.4, blackMat);
            addPart(0.8, 1, 0.4, side * 4 - 0.4, 87.8, 39.2, whiteMat);
            addSoftPart(6, 4, 4, side * 8, 88, 26, yellow, 1);
            addPart(2, 5, 2, side * 4, 92, 24, yellow);
            addSoftPart(4, 3, 4, side * 4, 95, 24, brown, 0.8);
            for (const z of [-10, 8]) addPart(0.8, 7, 7, side * 10.3, 40, z, brown);
            for (const y of [57, 70]) addPart(0.8, 5, 6, side * 4.3, y, 20, brown);
            for (const z of [-12, 12]) {
                addPart(6, 36, 6, side * 7, 18, z, yellow);
                addSoftPart(6.3, 4, 7, side * 7, 2, z + 0.5, brown, 1);
            }
        }
        addPart(2, 14, 2, 0, 32, -17, yellow);
        addSoftPart(4, 5, 4, 0, 24, -17, brown, 1);
    } else if (type === 'penguin') {
        heightOffset = 16;
        const black = new THREE.MeshPhysicalMaterial({ color: 0x303947, roughness: 0.7 });
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xffb64c, roughness: 0.7 });
        addSoftPart(22, 30, 18, 0, 17, 0, black, 4);
        addSoftPart(17, 23, 1, 0, 16, 9.1, whiteMat, 3);
        addSoftPart(20, 18, 18, 0, 34, 0, black, 3);
        addSoftPart(15, 12, 1, 0, 34, 9.1, whiteMat, 2.5);
        addSoftPart(8, 3, 7, 0, 32.5, 12, orange, 1);
        addPart(6, 1.5, 5, 0, 30.5, 12, orange);
        for (const side of [-1, 1]) {
            addPart(2.5, 3.5, 1, side * 4.5, 37, 10, blackMat);
            addPart(0.8, 1, 0.4, side * 4.5 - 0.4, 37.7, 10.8, whiteMat);
            const wing = addSoftPart(5, 16, 9, side * 12, 20, 0, black, 2);
            wing.rotation.z = side * 0.15;
            addSoftPart(8, 4, 12, side * 6, 2, 6, orange, 1.5);
        }
        addPart(8, 5, 5, 0, 8, -9, black);
    } else if (type === 'crocodile') {
        heightOffset = 6;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x59a579, roughness: 0.9 });
        const light = new THREE.MeshPhysicalMaterial({ color: 0xc6d993, roughness: 0.8 });
        const dark = new THREE.MeshPhysicalMaterial({ color: 0x397955, roughness: 0.9 });
        addSoftPart(24, 8, 40, 0, 4, 0, green, 2);
        addSoftPart(20, 7, 24, 0, 5, 32, green, 1.5);
        addPart(18, 2, 23, 0, 1, 32.5, light);
        addPart(12, 0.6, 0.7, 0, 3, 44.4, dark);
        addSoftPart(16, 7, 16, 0, 4, -27, green, 1);
        addSoftPart(10, 5, 12, 0, 3, -40, green, 1);
        addPart(5, 3, 9, 0, 2, -50, green);
        for (const z of [-14, -3, 8]) addSoftPart(8, 3, 6, 0, 9, z, dark, 1);
        for (const side of [-1, 1]) {
            addSoftPart(6, 6, 6, side * 7, 9, 29, green, 1);
            addPart(3, 3, 1, side * 7, 10, 32.5, blackMat);
            addPart(1, 1, 0.4, side * 7 - 0.5, 10.6, 33.3, whiteMat);
            addPart(2, 1, 1, side * 5, 8.6, 41, dark);
            for (const z of [-12, 12]) {
                addSoftPart(8, 6, 8, side * 16, 3, z, green, 1);
                addPart(7, 2, 4, side * 17, 1, z + 4, light);
            }
        }
    } else if (type === 'pig') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffc0cb, roughness: 0.8 });
        const rose = new THREE.MeshPhysicalMaterial({ color: 0xde829c, roughness: 0.8 });
        addSoftPart(24, 20, 32, 0, 14, 0, pink, 3);
        addSoftPart(18, 16, 16, 0, 24, 20, pink, 2);
        addSoftPart(10, 7, 4, 0, 21, 29.5, rose, 1);
        for (const side of [-1, 1]) {
            addPart(2.5, 3, 1, side * 5, 27, 28.5, blackMat);
            addPart(0.8, 1, 0.4, side * 5 - 0.4, 27.6, 29.3, whiteMat);
            addPart(1.5, 2, 0.6, side * 2.5, 21, 31.8, blackMat);
            addSoftPart(6, 7, 4, side * 7, 33, 18, pink, 1);
            addPart(3, 3, 1, side * 7, 34, 20.5, rose);
            for (const z of [-10, 10]) {
                addSoftPart(6, 8, 6, side * 8, 4, z, pink, 1);
                addPart(6.3, 2, 6.3, side * 8, 1, z, rose);
            }
        }
        addPart(2, 2, 6, 0, 16, -18, rose);
        addPart(5, 2, 2, 1.5, 16, -21, rose);
        addPart(2, 5, 2, 3, 18, -21, rose);
        addPart(4, 2, 2, 2, 20, -21, rose);
    } else if (type === 'turtle') {
        heightOffset = 8;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x3cb371, roughness: 0.8 });
        const darkGreen = new THREE.MeshPhysicalMaterial({ color: 0x387b4a, roughness: 0.9 });
        const shellTop = new THREE.MeshPhysicalMaterial({ color: 0x6ba45b, roughness: 0.9 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xe3dca1, roughness: 0.8 });
        addSoftPart(28, 16, 32, 0, 10, 0, darkGreen, 5);
        addSoftPart(16, 20, 0.8, 0, 17.9, -1, shellTop, 3).rotation.x = Math.PI / 2;
        addSoftPart(28, 2, 32, 0, 3, 0, cream, 2);
        addSoftPart(12, 12, 12, 0, 8, 20, green, 2);
        addPart(4, 0.7, 0.6, 0, 5.5, 26.4, darkGreen);
        for (const side of [-1, 1]) {
            addPart(2.5, 3, 1, side * 3.5, 10, 26.4, blackMat);
            addPart(0.8, 1, 0.4, side * 3.5 - 0.4, 10.6, 27.2, whiteMat);
            for (const z of [-12, 12]) addSoftPart(8, 4, 9, side * 16, 4, z, green, 1);
        }
        addPart(4, 4, 6, 0, 4, -18, green);
        addPart(2, 2, 5, 0, 4, -23, green);

    // ── 신규 10종 ──
    } else if (type === 'eevee') {
        heightOffset = 14;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0xc68642, roughness: 0.7 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfff5dc, roughness: 0.6 });
        addSoftPart(14, 12, 20, 0, 10, 0, brown, 2);
        addSoftPart(19, 9, 11, 0, 14, 6, cream, 3);
        addSoftPart(18, 16, 14, 0, 24, 6, brown, 3);
        addSoftPart(8, 4, 3, 0, 22, 13.5, cream, 1);
        addPart(2, 1.5, 1, 0, 23, 15.5, blackMat);
        for (const side of [-1, 1]) {
            addPart(3, 4, 1, side * 4.5, 27, 13.5, blackMat);
            addPart(1, 1.2, 0.4, side * 4.5 - 0.5, 27.8, 14.3, whiteMat);
            addSoftPart(6, 16, 4, side * 6, 36, 6, brown, 2);
            addSoftPart(3, 10, 0.8, side * 6, 36, 8.1, blackMat, 1);
            for (const z of [-6, 6]) {
                addSoftPart(4, 8, 4, side * 4, 4, z, brown, 0.8);
                addPart(4.5, 2, 5, side * 4, 1, z + 0.5, cream);
            }
        }
        addPart(5, 5, 10, 0, 12, -12, brown);
        addSoftPart(11, 12, 12, 0, 17, -19, brown, 3);
        addSoftPart(9, 9, 7, 0, 19, -25, cream, 2.5);
    } else if (type === 'kangaroo') {
        heightOffset = 28;
        const tan = new THREE.MeshPhysicalMaterial({ color: 0xd7a35d, roughness: 0.8 });
        const light = new THREE.MeshPhysicalMaterial({ color: 0xffdfaa, roughness: 0.7 });
        addSoftPart(20, 30, 19, 0, 24, 0, tan, 4);
        addSoftPart(17, 16, 15, 0, 44, 5, tan, 3);
        addSoftPart(9, 6, 6, 0, 41, 13, light, 1.5);
        addSoftPart(3, 2, 1.5, 0, 42.5, 16.5, blackMat, 0.7);
        addPart(4, 1, 0.6, 0, 39.5, 16.4, blackMat);
        addSoftPart(12, 10, 0.8, 0, 23, 9.6, light, 3);
        addPart(8, 1, 0.5, 0, 25.5, 10.3, tan);
        for (const side of [-1, 1]) {
            addPart(2.5, 3, 1, side * 4.5, 46, 12.8, blackMat);
            addPart(0.9, 1, 0.4, side * 4.5 - 0.4, 46.7, 13.6, whiteMat);
            addSoftPart(5, 12, 5, side * 5, 56, 5, tan, 2);
            addSoftPart(2.5, 8, 0.7, side * 5, 56, 7.6, light, 1);
            addSoftPart(7, 10, 6, side * 11, 33, 5, tan, 2);
            addSoftPart(10, 12, 11, side * 7, 11, 0, tan, 3);
            addSoftPart(7, 8, 7, side * 7, 6, 4, tan, 2);
            addSoftPart(8, 5, 16, side * 7, 2.5, 6, light, 2);
        }
        addSoftPart(8, 6, 12, 0, 12, -13, tan, 1);
        addSoftPart(6, 4, 10, 0, 9, -21, tan, 1);
        addSoftPart(3, 3, 6, 0, 7, -27, light, 0.7);

    } else if (type === 'frog') {
        heightOffset = 10;
        const fgreen = new THREE.MeshPhysicalMaterial({ color: 0x66bb6a, roughness: 0.6 });
        const belly = new THREE.MeshPhysicalMaterial({ color: 0xe1efb5, roughness: 0.5 });
        addSoftPart(20, 12, 20, 0, 8, 0, fgreen, 3);
        addSoftPart(12, 7, 1.5, 0, 7, 10.4, belly, 1.5);
        addSoftPart(20, 12, 16, 0, 18, 8, fgreen, 2);
        addPart(8, 1, 0.8, 0, 17, 16.6, blackMat);
        for (const side of [-1, 1]) {
            addSoftPart(6, 7, 5, side * 7, 25, 12, fgreen, 1.5);
            addSoftPart(4, 5, 0.8, side * 7, 26, 14.9, whiteMat, 0.7);
            addPart(3, 4, 0.8, side * 7, 26, 15.5, blackMat);
            addPart(1, 1.2, 0.4, side * 7 - 0.5, 27, 16.2, whiteMat);
            addPart(2, 2, 0.8, side * 4.5, 17.5, 16.6, blackMat);
            addSoftPart(3, 2, 0.8, side * 7.5, 18, 16.5, belly, 0.5);
            addSoftPart(6, 6, 13, side * 11, 4, -4, fgreen, 1.5);
            addSoftPart(8, 3, 6, side * 13, 1.5, -12, fgreen, 0.7);
            addSoftPart(4, 7, 4, side * 9, 5, 9, fgreen, 1);
            addSoftPart(6, 2, 6, side * 9, 1, 12, belly, 0.5);
        }

    // ── 신규: 벽타기 그룹 ──
    } else if (type === 'snail') {
        heightOffset = 10;
        const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xbc7f52, roughness: 0.6 });
        const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xe3bd6b, roughness: 0.5 });
        const spiral = new THREE.MeshPhysicalMaterial({ color: 0xf6d29d, roughness: 0.7 });
        addSoftPart(14, 5, 26, 0, 2.5, 0, bodyMat, 1.2);
        addSoftPart(12, 8, 10, 0, 9, 8, bodyMat, 2);
        addPart(4, 1, 0.8, 0, 8, 13.5, blackMat);
        addSoftPart(19, 26, 22, 0, 17, -5, shellMat, 6);
        for (const side of [-1, 1]) {
            addPart(2, 10, 2, side * 3.5, 18, 11, bodyMat);
            addSoftPart(5, 6, 4, side * 3.5, 24, 11, bodyMat, 1);
            addPart(3, 4, 1, side * 3.5, 24, 13.4, blackMat);
            addPart(1, 1.2, 0.4, side * 3.5 - 0.5, 25, 14.2, whiteMat);
            addSoftPart(15, 15, 0.6, side * 9.5, 17, -5, spiral, 4).rotation.y = side * Math.PI / 2;
            addSoftPart(9, 9, 0.6, side * 9.9, 17, -5, shellMat, 3).rotation.y = side * Math.PI / 2;
            addSoftPart(4, 4, 0.6, side * 10.3, 17, -5, spiral, 1.5).rotation.y = side * Math.PI / 2;
        }

    } else if (type === 'otter') {
        heightOffset = 19;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x987457, roughness: 0.9 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xf6dfb7, roughness: 0.9 });
        addSoftPart(22, 26, 22, 0, 18, 0, brown, 6);
        addSoftPart(16, 18, 1, 0, 18, 11.1, cream, 4);
        addSoftPart(25, 20, 23, 0, 36, 2, brown, 5);
        addSoftPart(15, 7, 4, 0, 32, 14, cream, 3);
        addSoftPart(4, 2.5, 1.5, 0, 34, 16.3, blackMat, 1);
        addSoftPart(4, 1, 0.5, 0, 30.5, 16.2, blackMat, 0.5);
        for (const side of [-1, 1]) {
            addSoftPart(5, 5, 4, side * 10.5, 44, 1, brown, 2);
            for (const level of [-1, 1]) {
                const whisker = addSoftPart(6, 1.8, 1, side * 9, 32 + level * 1.5, 14.7, cream, 0.8);
                whisker.rotation.z = side * level * 0.12;
            }
            addSoftPart(3, 3.5, 1, side * 6, 38, 13.7, blackMat, 1.2);
            addPart(1, 1, 0.4, side * 6 - 0.5, 38.7, 14.4, whiteMat);
            const arm = addSoftPart(7, 12, 8, side * 12, 21, 5, brown, 3);
            arm.rotation.z = side * 0.25;
            addSoftPart(9, 5, 12, side * 6, 2.5, 5, brown, 2);
        }
        addSoftPart(10, 6, 22, 0, 5, -17, brown, 3);
    } else if (type === 'panda') {
        heightOffset = 24;
        const ink = new THREE.MeshPhysicalMaterial({ color: 0x414b58, roughness: 0.95 });
        addSoftPart(29, 29, 25, 0, 20, 0, whiteMat, 7);
        addSoftPart(30, 25, 25, 0, 40, 2, whiteMat, 6);
        addSoftPart(13, 7, 2, 0, 36.5, 15, whiteMat, 3);
        addSoftPart(4, 2.5, 1, 0, 38, 16.2, ink, 1);
        addSoftPart(4, 1, 0.5, 0, 34.8, 16.1, ink, 0.5);
        for (const side of [-1, 1]) {
            addSoftPart(9, 10, 8, side * 11, 52, 2, ink, 4);
            const patch = addSoftPart(8, 10, 1, side * 7, 42, 14.6, ink, 3.5);
            patch.rotation.z = -side * 0.22;
            addSoftPart(2, 2.5, 0.5, side * 7 - 0.5, 43, 15.3, whiteMat, 0.8);
            const arm = addSoftPart(11, 17, 12, side * 17, 25, 1, ink, 4);
            arm.rotation.z = -side * 0.15;
            addSoftPart(12, 10, 15, side * 8, 5, 6, ink, 4);
        }
        addSoftPart(7, 7, 7, 0, 13, -13, whiteMat, 3);
    } else if (type === 'octopus') {
        heightOffset = 13;
        const coral = new THREE.MeshPhysicalMaterial({ color: 0xea9baa, roughness: 0.85 });
        const blush = new THREE.MeshPhysicalMaterial({ color: 0xd87996, roughness: 0.85 });
        addSoftPart(30, 28, 27, 0, 20, 0, coral, 7);
        // Eight short plush arms; no suckers or fine tentacle segments.
        for (let arm = 0; arm < 8; arm++) {
            const angle = arm * Math.PI / 4;
            addSoftPart(8, 10, 20, Math.sin(angle) * 13, 5, Math.cos(angle) * 13, coral, 4).rotation.y = angle;
        }
        for (const side of [-1, 1]) {
            addSoftPart(5, 6, 1, side * 6, 23, 13.7, whiteMat, 2);
            addSoftPart(3, 4, 0.7, side * 6, 23, 14.4, blackMat, 1.2);
            addPart(0.8, 1, 0.3, side * 6 - 0.5, 23.8, 14.9, whiteMat);
            addSoftPart(4, 2.5, 0.7, side * 10, 18, 13, blush, 1);
        }
        addSoftPart(3, 2.5, 0.7, 0, 16, 13.7, blackMat, 1.2);
    } else if (type === 'crab') {
        heightOffset = 10;
        const coral = new THREE.MeshPhysicalMaterial({ color: 0xeb957d, roughness: 0.9 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xffd9b0, roughness: 0.9 });
        addSoftPart(30, 17, 22, 0, 15, 0, coral, 6);
        addSoftPart(18, 7, 1, 0, 12, 11.1, cream, 3);
        addSoftPart(4, 1.5, 0.7, 0, 16, 11.3, blackMat, 0.7);
        for (const side of [-1, 1]) {
            for (const z of [-7, 1, 9]) {
                const leg = addSoftPart(11, 5, 6, side * 17, 2.5, z, coral, 2.4);
                leg.rotation.y = side * z * 0.05;
            }
            addSoftPart(8, 9, 8, side * 7, 26, 7, coral, 3.5);
            addSoftPart(5, 6, 1, side * 7, 28, 11.2, whiteMat, 2);
            addSoftPart(2.8, 4, 0.7, side * 7, 28, 11.9, blackMat, 1.2);
            addPart(0.8, 1, 0.3, side * 7 - 0.5, 28.8, 12.4, whiteMat);
            addSoftPart(12, 7, 8, side * 19, 15, 9, coral, 3);
            addSoftPart(11, 10, 11, side * 27, 20, 12, coral, 4);
            for (const jaw of [-1, 1]) {
                const claw = addSoftPart(5, 7, 8, side * 27 + jaw * 3, 26, 13, coral, 2.4);
                claw.rotation.z = -jaw * 0.15;
            }
        }
    } else if (type === 'hedgehog') {
        heightOffset = 12;
        const cocoa = new THREE.MeshPhysicalMaterial({ color: 0x987967, roughness: 0.95 });
        const tuft = new THREE.MeshPhysicalMaterial({ color: 0xb69a82, roughness: 0.95 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xf4ddba, roughness: 0.9 });
        addSoftPart(27, 22, 31, 0, 13, -2, cocoa, 7);
        addSoftPart(19, 15, 15, 0, 14, 17, cream, 5);
        addSoftPart(4, 3, 2, 0, 12, 25, blackMat, 1.4);
        // A few broad, rounded tufts suggest quills without sharp spikes.
        for (const x of [-8, 0, 8]) {
            for (const z of [-9, 1]) addSoftPart(9, 7, 9, x, 23, z, tuft, 3.4);
        }
        for (const side of [-1, 1]) {
            addSoftPart(6, 6, 5, side * 7, 22, 15, cream, 2.5);
            addSoftPart(3, 3.5, 0.8, side * 5, 17, 24.7, blackMat, 1.2);
            addPart(0.8, 1, 0.4, side * 5 - 0.5, 17.7, 25.3, whiteMat);
            for (const z of [-9, 9]) addSoftPart(6, 5, 7, side * 8, 2.5, z, cream, 2);
        }
        addSoftPart(4, 4, 5, 0, 5, -18, cream, 1.8);
    } else if (type === 'baby-dragon') {
        heightOffset = 22;
        const mint = new THREE.MeshPhysicalMaterial({ color: 0x9bcfba, roughness: 0.85 });
        const lavender = new THREE.MeshPhysicalMaterial({ color: 0xc1aedf, roughness: 0.85 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xffe4b1, roughness: 0.85 });
        addSoftPart(24, 28, 23, 0, 19, 0, mint, 6);
        addSoftPart(17, 18, 1, 0, 18, 11.6, cream, 4);
        addSoftPart(26, 23, 23, 0, 39, 3, mint, 6);
        addSoftPart(14, 8, 8, 0, 35, 15, mint, 3.5);
        addSoftPart(5, 1, 0.6, 0, 32.8, 19.2, blackMat, 0.5);
        for (const side of [-1, 1]) {
            addSoftPart(3.5, 4.5, 1, side * 7, 42, 14.7, blackMat, 1.5);
            addPart(1.2, 1.3, 0.4, side * 7 - 0.5, 42.8, 15.4, whiteMat);
            addSoftPart(1.5, 1.2, 0.6, side * 4, 36.5, 19.1, blackMat, 0.5);
            addSoftPart(5, 8, 5, side * 8, 53, 1, cream, 2.4);
            const arm = addSoftPart(7, 12, 7, side * 14, 23, 4, mint, 3);
            arm.rotation.z = -side * 0.2;
            addSoftPart(10, 6, 12, side * 8, 3, 6, mint, 2.5);
            addSoftPart(8, 10, 5, side * 12, 24, -8, lavender, 3);
            const wing = addSoftPart(12, 17, 4, side * 19, 29, -7, lavender, 4);
            wing.rotation.z = -side * 0.4;
            addSoftPart(9, 9, 4, side * 20, 22, -7, lavender, 3.5);
        }
        addSoftPart(10, 7, 15, 0, 9, -15, mint, 3);
        addSoftPart(7, 7, 11, 0, 11, -24, mint, 3).rotation.x = 0.35;
    }

    mergeStaticParts(animalGroup);

    // 발/꼬리 파트가 모델 원점 아래로 내려간 종도 지면에 파묻히지 않게 맞춘다.
    const modelBounds = new THREE.Box3().setFromObject(animalGroup);
    if (modelBounds.min.y < 0) {
        animalGroup.children.forEach(child => { child.position.y -= modelBounds.min.y; });
    }
    state.scene.add(animalGroup);

    const hw = (24 * u) / 2;
    const hh = heightOffset * (voxelSize / 20); // 메시 오프셋과 동일한 halfHeight로 맞춤
    const hd = (40 * u) / 2;
    const boxShape = new CANNON.Box(new CANNON.Vec3(hw, hh, hd));

    const spawnX = (Math.random() - 0.5) * 1600;
    const spawnZ = (Math.random() - 0.5) * 1600;
    const spawnY = Math.max(400 + Math.random() * 200, getGroundHeightAt(spawnX, spawnZ) + hh + voxelSize * 2);

    const body = new CANNON.Body({
        mass: 10,
        shape: boxShape,
        position: new CANNON.Vec3(spawnX, spawnY, spawnZ),
        material: state.animalMaterial || new CANNON.Material(),
        fixedRotation: true,
        linearDamping: 0.95
    });

    if (state.world) state.world.addBody(body);
    animalGroup.position.copy(body.position);
    animalGroup.position.y -= hh;

    const animGroup = ANIM_TYPE[type] || 'quadruped';
    const baseSpeed = 300 + Math.random() * 300;
    const speed = baseSpeed * (SPEED_MULT[animGroup] || 1.0);
    const clickActionType = CLICK_ACTION_OVERRIDES[type] || CLICK_ACTION_MAP[animGroup] || 'spin';
    const ability = getAnimalPowerInfo(type) || CLICK_ACTION_INFO[clickActionType];

    const animalData = {
        mesh: animalGroup,
        body: body,
        state: 'falling',
        timer: 1.0,
        targetDir: new THREE.Vector3(),
        speed: speed,
        heightOffset: heightOffset,
        grabbed: false,
        animalType: type,
        displayName: ANIMAL_NAMES[type] || type,
        abilityName: ability.name,
        abilityDescription: ability.description,
        animGroup,
        animTime: 0,
        _animYOffset: 0,
        baseScale: animalGroup.scale.clone(),
        clickActionTimer: 0,
        clickActionPhase: 0,
        clickActionType,
        clickBaseRotY: 0,
        // 먹이 AI 추가 필드
        isEating: false,
        eatTimer: 0,
        jumpCooldown: 0,
        // 육식동물 여부
        isCarnivore: (animGroup === 'CARNIVORE' || type === 'crocodile'),
        // SNEAK 벽 타기 필드
        isClimbing: false,
        climbTargetY: 0,
        climbDir: new THREE.Vector3(),
        climbMeshRotX: 0,
    };

    animalGroup.children.forEach(child => { child.userData.animalRef = animalData; });
    animals.push(animalData);
    playSound('animal-spawn');
    return animalData;
}

// Custom block friends use the same AI, picking, snack and cleanup paths as animals.
export function registerCustomAnimal(mesh, { position, size, blocks, animGroup, yaw = 0, livingDescriptor, eyes }) {
    const halfHeight = size.y / 2;
    const body = new CANNON.Body({
        mass: Math.max(10, blocks.length * 3),
        position: new CANNON.Vec3(position.x, position.y + halfHeight, position.z),
        material: state.animalMaterial || new CANNON.Material(),
        fixedRotation: true,
        linearDamping: 0.95
    });
    for (const block of blocks) {
        body.addShape(new CANNON.Box(new CANNON.Vec3(voxelSize / 2, voxelSize / 2, voxelSize / 2)),
            new CANNON.Vec3(block.pos[0], block.pos[1] - halfHeight, block.pos[2]));
    }
    body.quaternion.setFromEuler(0, yaw, 0);
    body.updateMassProperties();
    mesh.position.copy(position);
    mesh.rotation.y = yaw;
    const animal = {
        mesh, body, state: 'falling', timer: 0.5,
        targetDir: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)),
        speed: 280 * (SPEED_MULT[animGroup] || 1),
        heightOffset: size.y / (voxelSize / 10),
        grabbed: false, animalType: 'living-block', animGroup,
        animTime: 0, _animYOffset: 0, baseScale: mesh.scale.clone(),
        clickActionTimer: 0, clickActionPhase: 0,
        clickActionType: CLICK_ACTION_MAP[animGroup], clickBaseRotY: 0,
        isEating: false, eatTimer: 0, jumpCooldown: 0, isCarnivore: false,
        isClimbing: false, climbTargetY: 0,
        climbDir: new THREE.Vector3(), climbMeshRotX: 0,
        livingId: livingDescriptor.id, livingDescriptor,
        livingEyes: eyes, livingBlinkIn: 1.5 + Math.random() * 2.5,
        livingBlinkTimer: 0, livingSize: size.clone(),
        abilityName: livingDescriptor.abilityName,
        abilityDescription: livingDescriptor.abilityDescription
    };
    mesh.traverse(child => { child.userData.animalRef = animal; });
    state.scene.add(mesh);
    if (state.world) state.world.addBody(body);
    mesh.updateMatrixWorld(true);
    animals.push(animal);
    return animal;
}

// Undo reconciliation removes only its missing custom entity, without a new action.
export function removeAnimalImmediately(animal) {
    const index = animals.indexOf(animal);
    if (index === -1) return;
    animals.splice(index, 1);
    detachAnimalBody(animal);
    disposeAnimalMesh(animal.mesh);
}

// Transfer a playground's animals into the same timed physics lifecycle as
// exploding blocks. Living friends break at their current, animated positions.
export function detachAnimalsForExplosion() {
    const parts = [];
    for (const animal of [...animals]) {
        animal.mesh.updateWorldMatrix(true, true);
        if (animal.livingId) {
            const geometries = new Map(), materials = new Map();
            const fragments = [];
            animal.mesh.traverse(child => {
                if (!child.isMesh || child.name !== 'living-voxel') return;
                if (!geometries.has(child.geometry)) geometries.set(child.geometry, child.geometry.clone());
                const cloneMaterial = material => {
                    if (!materials.has(material)) materials.set(material, material.clone());
                    return materials.get(material);
                };
                const material = Array.isArray(child.material) ? child.material.map(cloneMaterial) : cloneMaterial(child.material);
                const mesh = new THREE.Mesh(geometries.get(child.geometry), material);
                mesh.name = 'exploding-living-voxel';
                child.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                state.scene.add(mesh);
                fragments.push({ mesh });
            });
            const fragmentResources = {
                geometries: [...geometries.values()], materials: [...materials.values()],
                references: fragments.length
            };
            fragments.forEach(part => { part.fragmentResources = fragmentResources; });
            parts.push(...fragments);
            removeAnimalImmediately(animal);
        } else {
            const mesh = animal.mesh;
            const displayedScale = mesh.scale.clone();
            animals.splice(animals.indexOf(animal), 1);
            detachAnimalBody(animal);
            mesh.scale.copy(displayedScale);
            mesh.traverse(child => { delete child.userData.animalRef; });
            const bounds = new THREE.Box3().setFromObject(mesh);
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const wrapper = new THREE.Group();
            wrapper.name = 'exploding-animal';
            wrapper.position.copy(center);
            mesh.position.sub(center);
            wrapper.add(mesh);
            state.scene.add(wrapper);
            parts.push({ mesh: wrapper, physicsSize: size, ownsMeshResources: true });
        }
    }
    return parts;
}

function getAnimalFullHeight(animal) {
    return animal.heightOffset * (voxelSize / 10);
}

function getCurrentStandingGroundY(animal) {
    if (!animal.body) return GROUND_BASE_HEIGHT;
    return getGroundHeightBelow(animal.body.position.x, animal.body.position.y + 0.5, animal.body.position.z, GROUND_BASE_HEIGHT);
}

function pickWanderDirection(animal) {
    const body = animal.body;
    if (!body) return;
    const fullHeight = getAnimalFullHeight(animal);
    const currentGroundY = getCurrentStandingGroundY(animal);
    const maxStep = voxelSize * 1.5;
    const sampleDist = voxelSize * 3;

    for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dirX = Math.sin(angle), dirZ = Math.cos(angle);
        const sampleX = body.position.x + dirX * sampleDist;
        const sampleZ = body.position.z + dirZ * sampleDist;
        const newGroundY = getGroundHeightBelow(sampleX, currentGroundY + fullHeight + 1, sampleZ, GROUND_BASE_HEIGHT);
        if (newGroundY - currentGroundY > maxStep) continue; // 위로는 제한, 아래로는 허용
        const ceilingY = getCeilingHeightAbove(sampleX, newGroundY + 0.1, sampleZ);
        if (ceilingY - newGroundY < fullHeight * 0.95) continue;
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
        animal.animTime += dt;
        if (animal.livingEyes) {
            animal.livingBlinkIn -= dt;
            if (animal.livingBlinkIn <= 0) {
                animal.livingBlinkTimer = 0.18;
                animal.livingBlinkIn = 2.0 + Math.random() * 3.0;
            }
            animal.livingBlinkTimer = Math.max(0, animal.livingBlinkTimer - dt);
            const openness = animal.livingBlinkTimer > 0
                ? Math.max(0.08, Math.abs(animal.livingBlinkTimer / 0.09 - 1)) : 1;
            animal.livingEyes.children.forEach(eye => { eye.scale.y = openness; });
        }
        if (animal.jumpCooldown > 0) animal.jumpCooldown -= dt;

        // ── 잡힌 상태 ──
        if (animal.grabbed) {
            if (animal.body) {
                animal.body.position.copy(animal.mesh.position);
                animal.body.position.y += animal.heightOffset * (voxelSize / 20);
                animal.body.velocity.set(0, 0, 0);
                animal.body.angularVelocity.set(0, 0, 0);
                animal.body.aabbNeedsUpdate = true;
            }
            animal.isClimbing = false;
            animal.climbMeshRotX = 0;
            animal.mesh.rotation.x = 0;
            return;
        }

        // ── 착지 감지 ──
        if (animal.magicEffect?.ingredients.includes('balloon')) {
            // Floating friends follow magic's breeze instead of ground AI.
            animal.state = 'idle'; animal.timer = 0;
            animal.isEating = false; animal.eatTimer = 0;
            animal.isClimbing = false; animal.climbMeshRotX = 0;
        } else if (animal.animalPower?.controlsMotion) {
            // A short toy ride owns movement and feeding until it finishes.
            animal.isClimbing = false;
            animal.climbMeshRotX = 0;
            animal.isEating = false;
            animal.eatTimer = 0;
        } else if (animal.trainRide) {
            // The train owns travel, including joining: friends keep their usual
            // visual animation and snacks without hunting, fleeing or smashing.
            animal.isClimbing = false;
            animal.climbMeshRotX = 0;
            if (animal.isEating) {
                animal.eatTimer -= dt;
                if (animal.eatTimer <= 0) animal.isEating = false;
            }
        } else if (animal.state === 'falling') {
            if (animal.body) {
                const halfHeight = animal.heightOffset * (voxelSize / 20);
                const groundY = getGroundHeightBelow(animal.body.position.x, animal.body.position.y + 0.5, animal.body.position.z, GROUND_BASE_HEIGHT);
                const targetY = groundY + halfHeight;
                // 고속 배속에서도 안정적으로 착지 감지: 하강 중이고 목표 위치에 충분히 가까우면 스냅
                if (animal.body.velocity.y <= 0 && Math.abs(animal.body.position.y - targetY) < halfHeight * 0.6) {
                    animal.body.position.y = targetY;
                    animal.body.velocity.y = 0;
                    animal.state = 'idle';
                    animal.timer = 0.3 + Math.random() * 0.7;
                }
            }
        } else if (animal.clickActionTimer <= 0) {
            const halfHeight = animal.heightOffset * (voxelSize / 20);
            const groundY = getCurrentStandingGroundY(animal);
            const targetFood = findNearestFood(animal);

            // ── 육식동물 도주 방향 계산 ──
            let fleeDir = null;
            if (!state.train && !animal.isCarnivore && animal.body) {
                for (const pred of animals) {
                    if (!pred.isCarnivore || pred.grabbed || pred.trainRide || !pred.body) continue;
                    const fdx = animal.body.position.x - pred.body.position.x;
                    const fdz = animal.body.position.z - pred.body.position.z;
                    const dist2 = fdx * fdx + fdz * fdz;
                    if (dist2 < FLEE_RADIUS * FLEE_RADIUS && dist2 > 1) {
                        const d = Math.sqrt(dist2);
                        fleeDir = new THREE.Vector3(fdx / d, 0, fdz / d);
                        break;
                    }
                }
            }

            // ── SNEAK / sliding 벽 타기 처리 ──
            if ((animal.animGroup === 'SNEAK' || animal.animGroup === 'sliding') && animal.isClimbing && animal.body) {
                const CLIMB_SPEED = Math.max(animal.speed * 3.0, 1800);
                // 등반 중에도 더 높은 블록이 있으면 목표 Y 갱신
                const midY = animal.body.position.y;
                _aimOrigin.set(animal.body.position.x, midY, animal.body.position.z);
                _aimRay.set(_aimOrigin, animal.climbDir);
                const climbCheckHits = _aimRay.intersectObjects(getBlockObjects(), false);
                if (climbCheckHits.length > 0 && climbCheckHits[0].distance < voxelSize * 3.5) {
                    const newTarget = getWallTopY(climbCheckHits[0].point, animal.climbDir) + halfHeight + voxelSize * 0.6;
                    if (newTarget > animal.climbTargetY) animal.climbTargetY = newTarget;
                }

                if (animal.body.position.y >= animal.climbTargetY) {
                    // 꼭대기 도달: 계속 전진
                    animal.isClimbing = false;
                    animal.jumpCooldown = 0.8; // 즉시 재등반 방지
                    animal.body.velocity.x = animal.climbDir.x * animal.speed;
                    animal.body.velocity.z = animal.climbDir.z * animal.speed;
                    animal.body.velocity.y = 0;
                    animal.state = 'walking';
                } else {
                    // 벽 타고 올라가는 중 — 충분한 속도로 중력 극복
                    animal.body.velocity.y = CLIMB_SPEED;
                    animal.body.velocity.x = animal.climbDir.x * CLIMB_SPEED * 0.35;
                    animal.body.velocity.z = animal.climbDir.z * CLIMB_SPEED * 0.35;
                    animal.mesh.rotation.y = Math.atan2(animal.climbDir.x, animal.climbDir.z); // 벽 방향 고정
                    animal.state = 'walking';
                }
            }
            // ── 먹는 중 ──
            else if (animal.isEating) {
                animal.eatTimer -= dt;
                if (animal.body) { animal.body.velocity.x = 0; animal.body.velocity.z = 0; }
                if (animal.eatTimer <= 0) {
                    animal.isEating = false;
                    animal.state = 'idle';
                    animal.timer = 1.0 + Math.random() * 1.0;
                }
            }
            // ── 육식동물 도주 AI ──
            else if (fleeDir && animal.clickActionTimer <= 0) {
                // targetDir 갱신 → 도주 종료 후에도 자연스럽게 같은 방향 유지
                animal.targetDir.copy(fleeDir);
                // 속도 스무딩: 급격한 방향 전환 억제 → 떨림 방지
                const fleeSpeed = animal.speed * 1.8;
                animal.body.velocity.x += (fleeDir.x * fleeSpeed - animal.body.velocity.x) * Math.min(dt * 10, 1);
                animal.body.velocity.z += (fleeDir.z * fleeSpeed - animal.body.velocity.z) * Math.min(dt * 10, 1);
                animal.mesh.rotation.y = Math.atan2(fleeDir.x, fleeDir.z);
                animal.state = 'walking';
                animal.timer = 0.8; // 도주 종료 후 0.8초간 같은 방향으로 계속 이동
            }
            // ── 먹이 추적 AI ──
            else if (targetFood && animal.clickActionTimer <= 0) {
                const dx = targetFood.position.x - animal.body.position.x;
                const dz = targetFood.position.z - animal.body.position.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const heightDiff = Math.abs(targetFood.position.y - (animal.body.position.y - halfHeight));

                if (dist < EAT_RADIUS && heightDiff < voxelSize * 1.5 && canReachFood(animal, targetFood)) {
                    // 먹기 시작!
                    if (!targetFood.eaten) {
                        targetFood.eaten = true;
                        targetFood.consumeTimer = 2.0;
                        applySnack(animal, targetFood.ingredients);
                    }
                    const floating = animal.magicEffect?.ingredients.includes('balloon');
                    animal.isEating = !floating;
                    animal.eatTimer = floating ? 0 : 1.2;
                    if (!floating) animal.state = 'idle';
                    playSound('food-eat');
                    if (animal.body && !floating) { animal.body.velocity.x = 0; animal.body.velocity.z = 0; }
                } else {
                    // 먹이 방향으로 이동
                    const desiredDir = new THREE.Vector3(dx, 0, dz).normalize();
                    animal.state = 'walking';

                    // 점프 중(상승)이면 장애물 회피 건너뜀 — 방향만 유지
                    if (animal.body.velocity.y > 80) {
                        animal.body.velocity.x = desiredDir.x * animal.speed;
                        animal.body.velocity.z = desiredDir.z * animal.speed;
                        animal.mesh.rotation.y = Math.atan2(desiredDir.x, desiredDir.z);
                    } else {
                        const wallHit = probeAhead(animal.body.position, desiredDir, groundY, halfHeight);

                        if (wallHit) {
                            const thickness = countThickness(wallHit, desiredDir);
                            const blockTop = getWallTopY(wallHit.point, desiredDir);

                            if (animal.animGroup === 'HOP' &&
                                blockTop <= groundY + voxelSize * 5 &&
                                thickness <= 4 &&
                                animal.jumpCooldown <= 0) {
                                // HOP: 점프로 넘기 (두께 ≤4, 높이 1~4블록)
                                animal.body.velocity.y = 1200;
                                animal.jumpCooldown = 1.5;
                                animal.body.velocity.x = desiredDir.x * animal.speed;
                                animal.body.velocity.z = desiredDir.z * animal.speed;
                                animal.mesh.rotation.y = Math.atan2(desiredDir.x, desiredDir.z);

                            } else if (animal.animGroup === 'HEAVY' &&
                                animal.jumpCooldown <= 0) {
                                // HEAVY: 2단 블록 폭발 파괴 후 관통
                                explodeBlockHeavy(wallHit.object, desiredDir);
                                // 바로 위 블록도 파괴
                                const upper = findBlockAtPos(
                                    wallHit.object.position.x,
                                    wallHit.object.position.y + voxelSize,
                                    wallHit.object.position.z
                                );
                                if (upper) explodeBlockHeavy(upper, desiredDir);
                                state.screenShakeTimer = 0.6;
                                state.screenShakeIntensity = 36;
                                animal.jumpCooldown = 1.0;
                                animal.body.velocity.x = desiredDir.x * animal.speed * 1.2;
                                animal.body.velocity.z = desiredDir.z * animal.speed * 1.2;

                            } else if ((animal.animGroup === 'SNEAK' || animal.animGroup === 'sliding') && !animal.isClimbing && animal.jumpCooldown <= 0) {
                                // SNEAK / sliding: 벽 타기 시작 — 스택 전체 꼭대기까지 목표 설정
                                animal.climbTargetY = getWallTopY(wallHit.point, desiredDir) + halfHeight + voxelSize * 0.6;
                                animal.climbDir.copy(desiredDir);
                                animal.isClimbing = true;

                            } else {
                                // 우회 탐색
                                const steerDir = steerAround(animal.body.position, desiredDir, groundY, halfHeight);
                                if (steerDir) {
                                    animal.body.velocity.x = steerDir.x * animal.speed;
                                    animal.body.velocity.z = steerDir.z * animal.speed;
                                    animal.mesh.rotation.y = Math.atan2(steerDir.x, steerDir.z);
                                } else {
                                    // 완전히 막힘 - 감속
                                    animal.body.velocity.x *= 0.85;
                                    animal.body.velocity.z *= 0.85;
                                }
                            }
                        } else {
                            // 직진
                            animal.body.velocity.x = desiredDir.x * animal.speed;
                            animal.body.velocity.z = desiredDir.z * animal.speed;
                            animal.mesh.rotation.y = Math.atan2(desiredDir.x, desiredDir.z);
                        }
                    }
                }
            }
            // ── 일반 배회 AI ──
            else {
                animal.timer -= dt;
                if (animal.timer <= 0) {
                    if (animal.state === 'idle') {
                        pickWanderDirection(animal);
                    } else {
                        animal.state = 'idle';
                        const restTime = animal.animGroup === 'HEAVY'
                            ? 1.5 + Math.random() * 3.0
                            : 0.5 + Math.random() * 1.5;
                        animal.timer = restTime;
                    }
                }

                // 일반 이동 & 경계 반사
                if (animal.state === 'walking' && animal.body) {
                    const predictX = animal.body.position.x + animal.targetDir.x * animal.speed * 0.5;
                    const predictZ = animal.body.position.z + animal.targetDir.z * animal.speed * 0.5;
                    const fullHeight = getAnimalFullHeight(animal);
                    const nextGroundY = getGroundHeightBelow(predictX, groundY + fullHeight, predictZ, GROUND_BASE_HEIGHT);
                    const maxStep = voxelSize * 1.5;

                    const outsideBoard = Math.abs(predictX) > boardLimit || Math.abs(predictZ) > boardLimit;
                    let blockForward = outsideBoard;
                    if (Math.abs(nextGroundY - groundY) > maxStep) blockForward = true;
                    const nextCeilingY = getCeilingHeightAbove(predictX, nextGroundY + 0.1, predictZ);
                    if (nextCeilingY - nextGroundY < fullHeight * 0.95) blockForward = true;

                    // ── HOP/HEAVY 전방 벽 감지 (배회 모드) ──
                    if (!outsideBoard && animal.body.velocity.y <= 80 && animal.jumpCooldown <= 0) {
                        const wHit = probeAhead(animal.body.position, animal.targetDir, groundY, halfHeight);
                        if (wHit) {
                            const wThick = countThickness(wHit, animal.targetDir);
                            const wTop = getWallTopY(wHit.point, animal.targetDir);
                            if (animal.animGroup === 'HOP' && wTop <= groundY + voxelSize * 5 && wThick <= 4) {
                                // HOP: 점프
                                blockForward = false;
                                animal.body.velocity.y = 1200;
                                animal.jumpCooldown = 1.5;
                                animal.body.velocity.x = animal.targetDir.x * animal.speed;
                                animal.body.velocity.z = animal.targetDir.z * animal.speed;
                            } else if (animal.animGroup === 'HEAVY') {
                                // HEAVY: 2단 블록 폭발 파괴
                                blockForward = false;
                                explodeBlockHeavy(wHit.object, animal.targetDir);
                                const wUpper = findBlockAtPos(
                                    wHit.object.position.x,
                                    wHit.object.position.y + voxelSize,
                                    wHit.object.position.z
                                );
                                if (wUpper) explodeBlockHeavy(wUpper, animal.targetDir);
                                state.screenShakeTimer = 0.6;
                                state.screenShakeIntensity = 36;
                                animal.jumpCooldown = 1.0;
                            } else if ((animal.animGroup === 'SNEAK' || animal.animGroup === 'sliding') && !animal.isClimbing) {
                                // SNEAK / sliding: 벽 타기 시작 — 스택 전체 꼭대기까지 목표 설정
                                blockForward = false;
                                animal.climbTargetY = getWallTopY(wHit.point, animal.targetDir) + halfHeight + voxelSize * 0.6;
                                animal.climbDir.copy(animal.targetDir);
                                animal.isClimbing = true;
                            } else {
                                blockForward = true; // 넘을 수 없으면 방향 전환
                            }
                        }
                    }

                    if (blockForward && !animal.isClimbing) {
                        animal.state = 'idle';
                        animal.timer = 0.2 + Math.random() * 0.3;
                        animal.body.velocity.x = 0;
                        animal.body.velocity.z = 0;
                    } else if (animal.body.velocity.y <= 80 && !animal.isClimbing) {
                        // 점프 중이 아닐 때만 수평 속도 덮어씀
                        animal.body.velocity.x = animal.targetDir.x * animal.speed;
                        animal.body.velocity.z = animal.targetDir.z * animal.speed;
                        animal.mesh.rotation.y = Math.atan2(animal.targetDir.x, animal.targetDir.z);
                    }
                } else if (animal.state === 'idle' && animal.body) {
                    animal.body.velocity.x = 0;
                    animal.body.velocity.z = 0;
                }
            }
        }

        // ── mesh 위치를 body에 동기화 ──
        if (animal.body) {
            if (animal.livingId) {
                animal.body.quaternion.setFromEuler(0, animal.mesh.rotation.y, 0);
                animal.body.aabbNeedsUpdate = true;
                animal.body.updateAABB();
            }
            // 먹이 추적, 도주, 클릭 대시에도 배회와 같은 보드 경계를 적용한다.
            for (const axis of ['x', 'z']) {
                const position = animal.body.position[axis];
                const extent = animal.livingId ? Math.max(
                    position - animal.body.aabb.lowerBound[axis],
                    animal.body.aabb.upperBound[axis] - position
                ) : 0;
                const limit = animal.livingId ? Math.min(boardLimit, Math.max(0, 1000 - extent - 12)) : boardLimit;
                if (Math.abs(position) >= limit) {
                    const edge = Math.sign(position);
                    animal.body.position[axis] = edge * limit;
                    animal.body.aabbNeedsUpdate = true;
                    if (animal.body.velocity[axis] * edge > 0) animal.body.velocity[axis] *= -1;
                    if (animal.targetDir[axis] * edge > 0) animal.targetDir[axis] *= -1;
                }
            }
            animal.mesh.position.copy(animal.body.position);
            animal.mesh.position.y -= (animal.heightOffset * (voxelSize / 20));
        }

        // ── SNEAK 벽 타기 mesh X축 기울기 ──
        if (animal.animGroup === 'SNEAK' && animal.clickActionTimer <= 0) {
            const targetRotX = animal.isClimbing ? -Math.PI / 2 : 0;
            animal.climbMeshRotX += (targetRotX - animal.climbMeshRotX) * Math.min(dt * 12, 1);
            animal.mesh.rotation.x = animal.climbMeshRotX;
        }

        // ── 타입별 루프 애니메이션 ──
        const baseY = animal.mesh.position.y;
        const t = animal.animTime;
        const baseScale = animal.baseScale;
        const isWalking = animal.state === 'walking';
        let yOffset = 0, sideTilt = 0;

        if (animal.isEating) {
            // 귀여운 먹기 애니메이션: 빠른 통통 + 살짝 기울기
            yOffset = Math.abs(Math.sin(t * 12)) * voxelSize * 0.18;
            sideTilt = Math.sin(t * 10) * 0.12;
        } else {
            switch (animal.animGroup) {
                case 'WADDLE':
                    sideTilt = Math.sin(t * 5) * 0.22;
                    yOffset = Math.abs(Math.sin(t * 5)) * 3;
                    break;
                case 'HOP':
                    if (isWalking) { yOffset = Math.abs(Math.sin(t * 8)) * 24; sideTilt = Math.sin(t * 16) * 0.06; }
                    else { yOffset = Math.abs(Math.sin(t * 3)) * 5; }
                    break;
                case 'SNEAK':
                    if (isWalking) { yOffset = Math.abs(Math.sin(t * 7)) * 2.5; sideTilt = Math.sin(t * 7) * 0.05; }
                    else { sideTilt = Math.sin(t * 1.8) * 0.07; }
                    break;
                case 'HEAVY':
                    yOffset = Math.abs(Math.sin(t * 1.8)) * 5;
                    sideTilt = Math.sin(t * 1.2) * 0.04;
                    break;
                case 'quadruped':
                    yOffset = Math.abs(Math.sin(t * 8)) * 4;
                    sideTilt = Math.sin(t * 6) * 0.08;
                    break;
                case 'CARNIVORE':
                    yOffset = Math.abs(Math.sin(t * 7)) * 5;
                    sideTilt = Math.sin(t * 5) * 0.1;
                    break;
                case 'hopping':
                    if (isWalking) yOffset = Math.abs(Math.sin(t * 6)) * 18;
                    break;
                case 'special':
                    yOffset = Math.abs(Math.sin(t * 2)) * 6;
                    animal.mesh.rotation.y += dt * 0.6;
                    break;
            }
        }

        animal.mesh.position.y = baseY + yOffset;
        if (sideTilt !== 0 && animal.clickActionTimer <= 0) {
            animal.mesh.rotation.z = sideTilt;
        }

        // ── 클릭 액션 오버레이 ──
        if (animal.clickActionTimer > 0) {
            animal.clickActionTimer -= dt;
            const duration = ACTION_DURATION[animal.clickActionType] || 0.75;
            const remaining = Math.max(animal.clickActionTimer, 0);
            const progress = 1 - remaining / duration;

            switch (animal.clickActionType) {
                case 'aerialSpin': {
                    if (animal.clickActionPhase === 0) {
                        animal.clickActionPhase = 1;
                        animal.clickBaseRotY = animal.mesh.rotation.y;
                        if (animal.body) animal.body.velocity.y = 420;
                    }
                    animal.mesh.rotation.y = animal.clickBaseRotY + progress * Math.PI * 4;
                    animal.mesh.rotation.z = Math.sin(progress * Math.PI) * 0.4;
                    break;
                }
                case 'waddleSpin': {
                    if (animal.clickActionPhase === 0) {
                        animal.clickActionPhase = 1;
                        animal.clickBaseRotY = animal.mesh.rotation.y;
                    }
                    animal.mesh.rotation.y = animal.clickBaseRotY + progress * Math.PI * 2;
                    animal.mesh.rotation.z = Math.sin(progress * Math.PI * 6) * 0.4;
                    break;
                }
                case 'dash': {
                    if (animal.clickActionPhase === 0) {
                        animal.clickActionPhase = 1;
                        if (animal.body) {
                            animal.body.velocity.x = Math.sin(animal.mesh.rotation.y) * 700;
                            animal.body.velocity.z = Math.cos(animal.mesh.rotation.y) * 700;
                        }
                    }
                    animal.mesh.rotation.x = -Math.sin(progress * Math.PI) * 0.3;
                    break;
                }
                case 'groundShake': {
                    if (animal.clickActionPhase === 0) {
                        animal.clickActionPhase = 1;
                        state.screenShakeTimer = 0.5;
                        state.screenShakeIntensity = 18;
                    }
                    const squash = 1 - Math.sin(progress * Math.PI) * 0.3;
                    animal.mesh.scale.set(baseScale.x / Math.max(squash, 0.01), baseScale.y * squash, baseScale.z / Math.max(squash, 0.01));
                    break;
                }
                case 'spin': {
                    if (animal.clickActionPhase === 0) { animal.clickBaseRotY = animal.mesh.rotation.y; animal.clickActionPhase = 1; }
                    animal.mesh.rotation.y = animal.clickBaseRotY + progress * Math.PI * 2;
                    break;
                }
                case 'scale': {
                    const s = 1 + Math.sin(progress * Math.PI) * 0.4;
                    animal.mesh.scale.set(baseScale.x * s, baseScale.y * s, baseScale.z * s);
                    break;
                }
                case 'jump': {
                    if (animal.clickActionPhase === 0) { animal.clickActionPhase = 1; if (animal.body) animal.body.velocity.y = 350; }
                    break;
                }
                case 'squash': {
                    const squash = 1 + Math.sin(progress * Math.PI) * 0.3;
                    animal.mesh.scale.set(baseScale.x * squash, baseScale.y / squash, baseScale.z * squash);
                    break;
                }
                case 'pulse': {
                    const p = 1 + Math.sin(progress * Math.PI * 2) * 0.25;
                    animal.mesh.scale.set(baseScale.x * p, baseScale.y * p, baseScale.z * p);
                    break;
                }
            }

            if (animal.clickActionTimer <= 0) {
                animal.clickActionTimer = 0;
                animal.clickActionPhase = 0;
                animal.mesh.scale.copy(baseScale);
                if (!(animal.animGroup === 'SNEAK' && animal.isClimbing)) {
                    animal.mesh.rotation.x = 0;
                }
                animal.mesh.rotation.z = 0;
            }
        } else {
            animal.mesh.scale.copy(baseScale);
        }
        if (animal.livingId && animal.body) {
            animal.body.quaternion.setFromEuler(0, animal.mesh.rotation.y, 0);
            animal.body.aabbNeedsUpdate = true;
        }
    });
    updateAnimalPowers(animals, dt);
}
