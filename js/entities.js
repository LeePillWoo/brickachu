import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, voxelSize, objects } from './state.js';
import { removeVoxel, explodeBlockHeavy } from './scene.js';
import { foods } from './food.js';

export const animals = [];
export const dogs = animals; // Aliased for backwards compatibility in main.js
const MAX_ANIMALS = 20;

export const GROUP_ANIMALS = {
    all:        ['dog','cat','rabbit','sheep','snake','pikachu','squirtle','charmander','meowth','snorlax','jigglypuff','diglett','porygon','ditto','elephant','penguin','pig','turtle','eevee','gengar','psyduck','bulbasaur','slowpoke','togepi','clefairy','wobbuffet','grasshopper','frog','snail','lizard','lion','crocodile','bear'],
    quad:       ['dog','cat','sheep','pig','bulbasaur','squirtle','charmander'],
    hop:        ['rabbit','pikachu','eevee','grasshopper','frog'],
    sneak:      ['snake','turtle','snail','lizard'],
    heavy:      ['snorlax','elephant','slowpoke','wobbuffet'],
    waddle:     ['penguin','psyduck','togepi','clefairy','jigglypuff','meowth'],
    special:    ['porygon','ditto','diglett','gengar'],
    carnivore:  ['lion','crocodile','bear'],
};

const GROUND_BASE_HEIGHT = 80;
const EAT_RADIUS = voxelSize * 1.8;

export let grabbedAnimal = null;
export function setGrabbedAnimal(a) { grabbedAnimal = a; }

export function clearAllAnimals() {
    while (animals.length > 0) {
        const animal = animals.pop();
        if (animal.mesh) state.scene.remove(animal.mesh);
        if (animal.body && state.world) state.world.removeBody(animal.body);
    }
    grabbedAnimal = null;
}

// ── 개별 제거: "뿅" 스케일 팝 → 축소 → 삭제 ──
export function removeAnimalWithEffect(animal) {
    const idx = animals.indexOf(animal);
    if (idx === -1) return;
    animals.splice(idx, 1);
    if (animal.body && state.world) state.world.removeBody(animal.body);

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
                state.scene.remove(mesh);
            }
        }
    }
    poof();
}

// ── 연기 파티클 헬퍼 ──
function _createSmokePoof(position) {
    const geo = new THREE.SphereGeometry(voxelSize * 0.28, 5, 5);
    const particles = [];
    for (let i = 0; i < 10; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xbbbbbb, transparent: true, opacity: 0.85 });
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
            p.life -= 0.034;
            if (p.life <= 0) { state.scene.remove(p.mesh); continue; }
            alive = true;
            p.mesh.position.addScaledVector(p.vel, 0.016);
            p.vel.y -= 55 * 0.016;
            const s = p.life * 2.6;
            p.mesh.scale.set(s, s, s);
            p.mesh.material.opacity = p.life * 0.8;
        }
        if (alive) requestAnimationFrame(animateSmoke);
    }
    animateSmoke();
}

// ── 전체 제거: 연기 파티클 + 축소 애니메이션 ──
export function removeAllAnimalsWithEffect() {
    const toRemove = [...animals];
    animals.length = 0;
    grabbedAnimal = null;

    toRemove.forEach(animal => {
        if (animal.body && state.world) state.world.removeBody(animal.body);
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
                state.scene.remove(mesh);
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
    return objects && state.plane ? objects.filter(o => o !== state.plane) : [];
}

export function getGroundHeightBelow(x, yStart, z, defaultY = GROUND_BASE_HEIGHT) {
    if (!objects || objects.length === 0) return GROUND_BASE_HEIGHT;
    RAY_ORIGIN.set(x, yStart + 10, z);
    _groundRaycaster.set(RAY_ORIGIN, _groundRayDown);
    const hits = _groundRaycaster.intersectObjects(objects, true);
    if (hits.length > 0) return hits[0].point.y;
    return GROUND_BASE_HEIGHT;
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
    for (let step = 1; step <= 3; step++) {
        _thicknessCheck.copy(firstHit.point).addScaledVector(direction, voxelSize * step);
        const found = blockObjects.some(obj => {
            const dx = obj.position.x - _thicknessCheck.x;
            const dz = obj.position.z - _thicknessCheck.z;
            return (dx * dx + dz * dz) < (voxelSize * voxelSize);
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
    if (foods.length === 0 || !animal.body) return null;
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
        if (food.eaten || food.consumeTimer > 0) continue;
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

// ── 애니메이션 그룹 매핑 ──
const ANIM_TYPE = {};
[
    ['WADDLE',    ['penguin', 'psyduck', 'togepi', 'clefairy', 'jigglypuff', 'meowth']],
    ['HOP',       ['rabbit', 'pikachu', 'eevee', 'grasshopper', 'frog']],
    ['SNEAK',     ['snake', 'turtle', 'snail', 'lizard', 'crocodile']],
    ['HEAVY',     ['snorlax', 'elephant', 'slowpoke', 'wobbuffet']],
    ['quadruped', ['dog', 'cat', 'sheep', 'pig', 'bulbasaur', 'squirtle', 'charmander']],
    ['CARNIVORE', ['lion', 'bear']],
    ['special',   ['porygon', 'ditto', 'diglett', 'gengar']],
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
    if (animal.clickActionTimer > 0) return;
    const actionType = CLICK_ACTION_MAP[animal.animGroup] || 'spin';
    animal.clickActionTimer = ACTION_DURATION[actionType] || 0.75;
    animal.clickActionPhase = 0;
    animal.clickActionType = actionType;
}

function getRandomColor() {
    const r = Math.floor(Math.random() * 200 + 55);
    const g = Math.floor(Math.random() * 200 + 55);
    const b = Math.floor(Math.random() * 200 + 55);
    return (r << 16) | (g << 8) | b;
}

export function spawnDog(group = 'all') {
    if (animals.length >= MAX_ANIMALS) removeOldestAnimal();

    const animalGroup = new THREE.Group();
    const u = voxelSize / 25;

    let pool = GROUP_ANIMALS[group] || GROUP_ANIMALS.all;
    // 육식동물이 이미 최대치면 풀에서 제외
    const carnivoreCount = animals.filter(a => a.isCarnivore).length;
    if (carnivoreCount >= MAX_CARNIVORES) {
        pool = pool.filter(t => !GROUP_ANIMALS.carnivore.includes(t));
        if (pool.length === 0) pool = GROUP_ANIMALS.all.filter(t => !GROUP_ANIMALS.carnivore.includes(t));
    }
    const type = pool[Math.floor(Math.random() * pool.length)];

    const baseColor = getRandomColor();
    const secondaryColor = getRandomColor();
    const accentColor = getRandomColor();

    const matBase = new THREE.MeshPhysicalMaterial({ color: baseColor, roughness: 0.8 });
    const matSec  = new THREE.MeshPhysicalMaterial({ color: secondaryColor, roughness: 0.8 });
    const matAcc  = new THREE.MeshPhysicalMaterial({ color: accentColor, roughness: 0.8 });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.9 });
    const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.9 });

    function addPart(w, h, d, x, y, z, mat = matBase) {
        const geo = new THREE.BoxGeometry(w * u, h * u, d * u);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x * u, y * u, z * u);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isAnimalPart = true;
        animalGroup.add(mesh);
        return mesh;
    }

    let heightOffset = 20;

    if (type === 'dog') {
        heightOffset = 20;
        addPart(20, 16, 32, 0, 16, 0);
        addPart(16, 16, 16, 0, 32, 24);
        addPart(8, 6, 8, 0, 28, 36, matSec);
        addPart(2, 2, 2, 0, 31, 40, blackMat);
        addPart(2, 2, 2, -5, 36, 32, blackMat); addPart(2, 2, 2, 5, 36, 32, blackMat);
        addPart(4, 8, 4, -6, 44, 24, matSec); addPart(4, 8, 4, 6, 44, 24, matSec);
        const tail = addPart(4, 12, 4, 0, 28, -16, matAcc); tail.rotation.x = -Math.PI / 4;
        addPart(6, 12, 6, -6, 6, 10); addPart(6, 12, 6, 6, 6, 10);
        addPart(6, 12, 6, -6, 6, -10); addPart(6, 12, 6, 6, 6, -10);
    } else if (type === 'cat') {
        heightOffset = 16;
        addPart(16, 12, 24, 0, 12, 0);
        addPart(12, 12, 12, 0, 24, 18);
        addPart(2, 2, 2, 0, 22, 25, matSec);
        addPart(2, 2, 2, -4, 26, 24, blackMat); addPart(2, 2, 2, 4, 26, 24, blackMat);
        addPart(4, 6, 4, -4, 32, 20, matAcc); addPart(4, 6, 4, 4, 32, 20, matAcc);
        const tail = addPart(4, 20, 4, 0, 24, -12, matSec); tail.rotation.x = Math.PI / 6;
        addPart(4, 8, 4, -4, 4, 8); addPart(4, 8, 4, 4, 4, 8);
        addPart(4, 8, 4, -4, 4, -8); addPart(4, 8, 4, 4, 4, -8);
    } else if (type === 'rabbit') {
        heightOffset = 12;
        addPart(12, 12, 16, 0, 10, 0, whiteMat);
        addPart(10, 10, 10, 0, 20, 10, whiteMat);
        addPart(2, 2, 2, 0, 18, 16, matSec);
        addPart(2, 2, 2, -3, 22, 15, blackMat); addPart(2, 2, 2, 3, 22, 15, blackMat);
        addPart(4, 16, 4, -3, 32, 12, matSec); addPart(4, 16, 4, 3, 32, 12, matSec);
        addPart(6, 6, 6, 0, 12, -10, whiteMat);
        addPart(4, 6, 4, -4, 3, 6, whiteMat); addPart(4, 6, 4, 4, 3, 6, whiteMat);
        addPart(4, 8, 8, -4, 4, -6, whiteMat); addPart(4, 8, 8, 4, 4, -6, whiteMat);
    } else if (type === 'sheep') {
        heightOffset = 20;
        addPart(24, 20, 28, 0, 18, 0, whiteMat);
        addPart(12, 12, 16, 0, 28, 22, blackMat);
        addPart(2, 2, 2, -4, 30, 28, whiteMat); addPart(2, 2, 2, 4, 30, 28, whiteMat);
        addPart(4, 4, 8, -8, 28, 20, whiteMat); addPart(4, 4, 8, 8, 28, 20, whiteMat);
        addPart(4, 10, 4, -6, 5, 10, blackMat); addPart(4, 10, 4, 6, 5, 10, blackMat);
        addPart(4, 10, 4, -6, 5, -10, blackMat); addPart(4, 10, 4, 6, 5, -10, blackMat);
    } else if (type === 'snake') {
        heightOffset = 6;
        addPart(8, 6, 48, 0, 3, 0, matBase);
        addPart(10, 8, 12, 0, 4, 30, matSec);
        addPart(2, 2, 2, -4, 8, 34, blackMat); addPart(2, 2, 2, 4, 8, 34, blackMat);
        addPart(4, 2, 8, 0, 4, 38, matAcc);
    } else if (type === 'horse') {
        heightOffset = 32;
        addPart(20, 20, 40, 0, 32, 0);
        addPart(12, 24, 12, 0, 48, 24);
        addPart(12, 12, 20, 0, 56, 32);
        addPart(2, 2, 2, -5, 60, 40, blackMat); addPart(2, 2, 2, 5, 60, 40, blackMat);
        addPart(4, 24, 8, 0, 48, 18, matSec);
        const tail = addPart(6, 24, 6, 0, 32, -20, matSec); tail.rotation.x = -Math.PI / 8;
        addPart(6, 24, 6, -7, 12, 16, matAcc); addPart(6, 24, 6, 7, 12, 16, matAcc);
        addPart(6, 24, 6, -7, 12, -16, matAcc); addPart(6, 24, 6, 7, 12, -16, matAcc);
    } else if (type === 'pikachu') {
        heightOffset = 16;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.6 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.8 });
        addPart(16, 20, 16, 0, 10, 0, yellow);
        addPart(16, 16, 16, 0, 28, 4, yellow);
        addPart(2, 2, 2, -5, 28, 12, blackMat); addPart(2, 2, 2, 5, 28, 12, blackMat);
        addPart(4, 4, 2, -6, 26, 12, red); addPart(4, 4, 2, 6, 26, 12, red);
        addPart(4, 16, 4, -6, 40, 4, yellow); addPart(4, 4, 4, -6, 48, 4, blackMat);
        addPart(4, 16, 4, 6, 40, 4, yellow); addPart(4, 4, 4, 6, 48, 4, blackMat);
        const pTail = addPart(4, 20, 12, 0, 16, -12, yellow); pTail.rotation.x = -Math.PI / 4;
        addPart(4, 6, 6, -4, 3, 4, yellow); addPart(4, 6, 6, 4, 3, 4, yellow);
    } else if (type === 'squirtle') {
        heightOffset = 16;
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x4fc3f7, roughness: 0.6 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8d6e63, roughness: 0.8 });
        addPart(16, 16, 12, 0, 12, 0, blue); addPart(20, 20, 8, 0, 12, -4, brown);
        addPart(16, 16, 16, 0, 28, 4, blue);
        addPart(2, 4, 2, -5, 30, 12, blackMat); addPart(2, 4, 2, 5, 30, 12, blackMat);
        addPart(6, 6, 6, -8, 16, 8, blue); addPart(6, 6, 6, 8, 16, 8, blue);
        addPart(6, 8, 8, -6, 4, 4, blue); addPart(6, 8, 8, 6, 4, 4, blue);
        const sTail = addPart(8, 8, 12, 0, 8, -12, blue); sTail.rotation.x = Math.PI / 4;
    } else if (type === 'charmander') {
        heightOffset = 16;
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xff9800, roughness: 0.6 });
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffeb3b, roughness: 0.8 });
        const fire = new THREE.MeshPhysicalMaterial({ color: 0xff3d00, roughness: 0.2, emissive: 0xff3d00 });
        addPart(16, 18, 16, 0, 12, 0, orange); addPart(12, 14, 2, 0, 10, 8, yellow);
        addPart(16, 16, 16, 0, 28, 4, orange);
        addPart(2, 4, 2, -5, 30, 12, blackMat); addPart(2, 4, 2, 5, 30, 12, blackMat);
        addPart(4, 8, 4, -8, 16, 8, orange); addPart(4, 8, 4, 8, 16, 8, orange);
        addPart(6, 8, 8, -6, 4, 4, orange); addPart(6, 8, 8, 6, 4, 4, orange);
        const cTail = addPart(6, 6, 20, 0, 8, -12, orange); cTail.rotation.x = Math.PI / 6;
        addPart(4, 8, 4, 0, 16, -24, fire);
    } else if (type === 'meowth') {
        heightOffset = 16;
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfffdd0, roughness: 0.7 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.7 });
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.3 });
        addPart(12, 16, 12, 0, 12, 0, cream); addPart(16, 16, 12, 0, 28, 2, cream);
        addPart(2, 2, 2, -4, 30, 8, blackMat); addPart(2, 2, 2, 4, 30, 8, blackMat);
        addPart(4, 8, 4, -6, 38, 2, brown); addPart(4, 8, 4, 6, 38, 2, brown);
        addPart(6, 8, 2, 0, 32, 8, gold);
        addPart(4, 12, 4, -8, 16, 2, cream); addPart(4, 12, 4, 8, 16, 2, cream);
        addPart(6, 6, 8, -5, 3, 4, brown); addPart(6, 6, 8, 5, 3, 4, brown);
        const mTail = addPart(4, 20, 4, 0, 12, -8, brown); mTail.rotation.x = Math.PI / 8;
    } else if (type === 'snorlax') {
        heightOffset = 24;
        const teal = new THREE.MeshPhysicalMaterial({ color: 0x008080, roughness: 0.8 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xf5f5dc, roughness: 0.8 });
        addPart(40, 36, 32, 0, 20, 0, teal); addPart(32, 28, 8, 0, 18, 16, cream);
        addPart(24, 20, 20, 0, 48, 0, teal); addPart(16, 12, 4, 0, 48, 10, cream);
        addPart(4, 2, 2, -6, 50, 12, blackMat); addPart(4, 2, 2, 6, 50, 12, blackMat);
        addPart(6, 8, 6, -8, 60, 0, teal); addPart(6, 8, 6, 8, 60, 0, teal);
        addPart(10, 16, 10, -24, 24, 4, teal); addPart(10, 16, 10, 24, 24, 4, teal);
        addPart(10, 10, 12, -12, 5, 12, cream); addPart(10, 10, 12, 12, 5, 12, cream);
    } else if (type === 'jigglypuff') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffb6c1, roughness: 0.7 });
        addPart(24, 24, 24, 0, 12, 0, pink);
        addPart(4, 4, 2, -6, 14, 12, blackMat); addPart(4, 4, 2, 6, 14, 12, blackMat);
        addPart(6, 8, 6, -6, 26, 0, pink); addPart(6, 8, 6, 6, 26, 0, pink);
        addPart(8, 6, 6, 0, 26, 8, pink);
        addPart(6, 6, 6, -12, 12, 4, pink); addPart(6, 6, 6, 12, 12, 4, pink);
        addPart(8, 4, 10, -6, 2, 8, pink); addPart(8, 4, 10, 6, 2, 8, pink);
    } else if (type === 'diglett') {
        heightOffset = 8;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const dirt = new THREE.MeshPhysicalMaterial({ color: 0x5c4033, roughness: 1.0 });
        addPart(28, 4, 28, 0, 2, 0, dirt); addPart(16, 20, 16, 0, 12, 0, brown);
        addPart(2, 4, 2, -4, 16, 8, blackMat); addPart(2, 4, 2, 4, 16, 8, blackMat);
        addPart(8, 4, 6, 0, 12, 8, pink);
    } else if (type === 'porygon') {
        heightOffset = 16;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x00bfff, roughness: 0.5 });
        addPart(16, 16, 16, 0, 12, 0, pink); addPart(12, 12, 12, 0, 28, 6, pink);
        addPart(4, 4, 4, -6, 30, 8, blackMat); addPart(4, 4, 4, 6, 30, 8, blackMat);
        addPart(8, 8, 16, 0, 24, 18, blue);
        addPart(12, 16, 8, -12, 12, 0, blue); addPart(12, 16, 8, 12, 12, 0, blue);
        const pTail = addPart(8, 8, 12, 0, 12, -12, blue); pTail.rotation.x = -Math.PI / 4;
    } else if (type === 'ditto') {
        heightOffset = 8;
        const purple = new THREE.MeshPhysicalMaterial({ color: 0xdda0dd, roughness: 0.4, transmission: 0.2 });
        addPart(24, 12, 20, 0, 6, 0, purple); addPart(16, 12, 16, 0, 14, 0, purple);
        addPart(2, 2, 2, -4, 16, 8, blackMat); addPart(2, 2, 2, 4, 16, 8, blackMat);
        addPart(8, 8, 8, -10, 10, 4, purple); addPart(8, 8, 8, 10, 10, 4, purple);
    } else if (type === 'lion') {
        heightOffset = 24;
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xdaa520, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(20, 20, 36, 0, 24, 0, gold); addPart(28, 28, 12, 0, 32, 20, brown);
        addPart(16, 16, 16, 0, 32, 28, gold);
        addPart(4, 4, 4, -6, 34, 36, blackMat); addPart(4, 4, 4, 6, 34, 36, blackMat);
        addPart(8, 8, 8, 0, 28, 36, blackMat);
        const tail = addPart(4, 20, 4, 0, 24, -20, gold); tail.rotation.x = -Math.PI / 6;
        addPart(6, 6, 6, 0, 4, -28, brown);
        addPart(6, 16, 6, -7, 8, 14, gold); addPart(6, 16, 6, 7, 8, 14, gold);
        addPart(6, 16, 6, -7, 8, -14, gold); addPart(6, 16, 6, 7, 8, -14, gold);
    } else if (type === 'elephant') {
        heightOffset = 36;
        const grey = new THREE.MeshPhysicalMaterial({ color: 0x808080, roughness: 0.8 });
        addPart(36, 32, 48, 0, 32, 0, grey); addPart(28, 28, 28, 0, 40, 32, grey);
        addPart(4, 4, 4, -10, 44, 46, blackMat); addPart(4, 4, 4, 10, 44, 46, blackMat);
        addPart(8, 20, 8, 0, 30, 48, grey); addPart(6, 10, 6, 0, 15, 48, grey);
        addPart(20, 28, 4, -24, 36, 28, grey); addPart(20, 28, 4, 24, 36, 28, grey);
        addPart(12, 20, 12, -12, 10, 16, grey); addPart(12, 20, 12, 12, 10, 16, grey);
        addPart(12, 20, 12, -12, 10, -16, grey); addPart(12, 20, 12, 12, 10, -16, grey);
    } else if (type === 'giraffe') {
        heightOffset = 60;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(20, 20, 32, 0, 40, 0, yellow);
        addPart(6, 2, 6, -10, 40, 5, brown); addPart(6, 2, 6, 10, 40, -5, brown);
        addPart(8, 40, 12, 0, 64, 20, yellow); addPart(12, 12, 20, 0, 84, 28, yellow);
        addPart(4, 4, 4, -6, 86, 38, blackMat); addPart(4, 4, 4, 6, 86, 38, blackMat);
        addPart(4, 6, 4, -4, 92, 24, brown); addPart(4, 6, 4, 4, 92, 24, brown);
        addPart(6, 36, 6, -7, 18, 12, yellow); addPart(6, 36, 6, 7, 18, 12, yellow);
        addPart(6, 36, 6, -7, 18, -12, yellow); addPart(6, 36, 6, 7, 18, -12, yellow);
    } else if (type === 'penguin') {
        heightOffset = 16;
        const black = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.6 });
        const white = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.8 });
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xffa500, roughness: 0.6 });
        addPart(20, 28, 16, 0, 16, 0, black); addPart(16, 24, 4, 0, 16, 9, white);
        addPart(16, 16, 16, 0, 36, 0, black);
        addPart(4, 4, 4, -4, 38, 8, blackMat); addPart(4, 4, 4, 4, 38, 8, blackMat);
        addPart(12, 12, 4, 0, 36, 9, white); addPart(8, 4, 8, 0, 32, 12, orange);
        addPart(4, 20, 8, -12, 20, 0, black); addPart(4, 20, 8, 12, 20, 0, black);
        addPart(8, 4, 12, -6, 2, 6, orange); addPart(8, 4, 12, 6, 2, 6, orange);
    } else if (type === 'crocodile') {
        heightOffset = 6;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x2e8b57, roughness: 0.9 });
        addPart(24, 8, 40, 0, 4, 0, green); addPart(20, 8, 24, 0, 4, 32, green);
        addPart(4, 4, 4, -8, 8, 36, blackMat); addPart(4, 4, 4, 8, 8, 36, blackMat);
        addPart(16, 8, 36, 0, 4, -36, green);
        addPart(8, 6, 8, -16, 3, 12, green); addPart(8, 6, 8, 16, 3, 12, green);
        addPart(8, 6, 8, -16, 3, -12, green); addPart(8, 6, 8, 16, 3, -12, green);
    } else if (type === 'pig') {
        heightOffset = 12;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffc0cb, roughness: 0.8 });
        addPart(24, 20, 32, 0, 14, 0, pink); addPart(16, 16, 16, 0, 24, 20, pink);
        addPart(4, 4, 4, -4, 26, 28, blackMat); addPart(4, 4, 4, 4, 26, 28, blackMat);
        addPart(8, 8, 4, 0, 20, 30, pink);
        addPart(4, 6, 4, -6, 32, 16, pink); addPart(4, 6, 4, 6, 32, 16, pink);
        addPart(6, 8, 6, -8, 4, 10, pink); addPart(6, 8, 6, 8, 4, 10, pink);
        addPart(6, 8, 6, -8, 4, -10, pink); addPart(6, 8, 6, 8, 4, -10, pink);
    } else if (type === 'turtle') {
        heightOffset = 8;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x3cb371, roughness: 0.8 });
        const darkGreen = new THREE.MeshPhysicalMaterial({ color: 0x006400, roughness: 0.9 });
        addPart(28, 12, 32, 0, 8, 0, darkGreen); addPart(12, 12, 12, 0, 8, 20, green);
        addPart(2, 2, 2, -4, 10, 26, blackMat); addPart(2, 2, 2, 4, 10, 26, blackMat);
        addPart(8, 4, 8, -16, 4, 12, green); addPart(8, 4, 8, 16, 4, 12, green);
        addPart(8, 4, 8, -16, 4, -12, green); addPart(8, 4, 8, 16, 4, -12, green);
        addPart(4, 4, 8, 0, 4, -20, green);

    // ── 신규 10종 ──
    } else if (type === 'eevee') {
        heightOffset = 14;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0xc68642, roughness: 0.7 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfff5dc, roughness: 0.6 });
        addPart(14, 12, 20, 0, 10, 0, brown);
        addPart(22, 8, 10, 0, 14, 6, cream);
        addPart(14, 13, 14, 0, 24, 6, brown);
        addPart(2, 2, 2, -4, 28, 13, blackMat); addPart(2, 2, 2, 4, 28, 13, blackMat);
        addPart(6, 8, 2, -5, 35, 6, brown); addPart(6, 8, 2, 5, 35, 6, brown);
        addPart(8, 5, 3, 0, 25, 13, cream);
        addPart(4, 4, 14, 0, 12, -14, brown);
        addPart(6, 5, 5, -4, 14, -22, cream); addPart(6, 5, 5, 2, 16, -22, cream); addPart(6, 5, 5, 6, 13, -21, cream);
        addPart(4, 8, 4, -4, 3, 6, brown); addPart(4, 8, 4, 4, 3, 6, brown);
        addPart(4, 8, 4, -4, 3, -6, brown); addPart(4, 8, 4, 4, 3, -6, brown);
    } else if (type === 'vulpix') {
        heightOffset = 12;
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xe8743b, roughness: 0.7 });
        const redTip = new THREE.MeshPhysicalMaterial({ color: 0xcc3300, roughness: 0.8 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfff0c0, roughness: 0.6 });
        addPart(12, 12, 18, 0, 10, 0, orange); addPart(12, 12, 12, 0, 22, 5, orange);
        addPart(2, 2, 2, -3, 26, 11, blackMat); addPart(2, 2, 2, 3, 26, 11, blackMat);
        addPart(2, 2, 2, 0, 23, 13, blackMat);
        addPart(4, 8, 2, -4, 32, 5, orange); addPart(4, 4, 2, -4, 40, 5, redTip);
        addPart(4, 8, 2, 4, 32, 5, orange); addPart(4, 4, 2, 4, 40, 5, redTip);
        addPart(6, 4, 4, 0, 24, 14, cream);
        addPart(4, 4, 12, -5, 10, -12, orange); addPart(4, 4, 4, -5, 10, -22, redTip);
        addPart(4, 4, 12, 0, 12, -12, orange); addPart(4, 4, 4, 0, 12, -22, redTip);
        addPart(4, 4, 12, 5, 10, -12, orange); addPart(4, 4, 4, 5, 10, -22, redTip);
        addPart(4, 6, 4, -4, 3, 6, orange); addPart(4, 6, 4, 4, 3, 6, orange);
        addPart(4, 6, 4, -4, 3, -6, orange); addPart(4, 6, 4, 4, 3, -6, orange);
    } else if (type === 'gengar') {
        heightOffset = 16;
        const purple = new THREE.MeshPhysicalMaterial({ color: 0x6a0dad, roughness: 0.5 });
        const dpurple = new THREE.MeshPhysicalMaterial({ color: 0x4b0082, roughness: 0.6 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xff2020, roughness: 0.5 });
        addPart(24, 22, 20, 0, 12, 0, purple); addPart(22, 20, 20, 0, 26, 2, purple);
        addPart(4, 4, 2, -6, 32, 10, red); addPart(4, 4, 2, 6, 32, 10, red);
        addPart(2, 2, 2, -6, 32, 10, blackMat); addPart(2, 2, 2, 6, 32, 10, blackMat);
        addPart(16, 3, 2, 0, 25, 12, whiteMat);
        addPart(2, 4, 2, -5, 23, 12, whiteMat); addPart(2, 4, 2, -2, 23, 12, whiteMat);
        addPart(2, 4, 2, 2, 23, 12, whiteMat); addPart(2, 4, 2, 5, 23, 12, whiteMat);
        addPart(6, 10, 4, -6, 36, 2, dpurple); addPart(6, 10, 4, 6, 36, 2, dpurple);
        addPart(10, 8, 8, -12, 16, 4, purple); addPart(10, 8, 8, 12, 16, 4, purple);
        addPart(6, 8, 6, -8, 3, 0, dpurple); addPart(6, 8, 6, 0, 2, 0, dpurple); addPart(6, 8, 6, 8, 3, 0, dpurple);
    } else if (type === 'psyduck') {
        heightOffset = 16;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd54f, roughness: 0.6 });
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xff6d00, roughness: 0.7 });
        addPart(16, 18, 14, 0, 12, 0, yellow); addPart(18, 18, 18, 0, 28, 2, yellow);
        addPart(2, 2, 2, -5, 32, 10, blackMat); addPart(2, 2, 2, 5, 32, 10, blackMat);
        addPart(8, 5, 4, 0, 27, 12, orange);
        addPart(4, 2, 4, -8, 32, 2, yellow); addPart(4, 2, 4, 8, 32, 2, yellow);
        const lArm = addPart(6, 12, 4, -12, 22, 4, yellow); lArm.rotation.z = Math.PI / 3;
        const rArm = addPart(6, 12, 4, 12, 22, 4, yellow); rArm.rotation.z = -Math.PI / 3;
        addPart(8, 6, 10, -6, 3, 4, yellow); addPart(8, 6, 10, 6, 3, 4, yellow);
    } else if (type === 'bulbasaur') {
        heightOffset = 14;
        const blueGreen = new THREE.MeshPhysicalMaterial({ color: 0x78c878, roughness: 0.7 });
        const dgreen = new THREE.MeshPhysicalMaterial({ color: 0x228b22, roughness: 0.8 });
        const spot = new THREE.MeshPhysicalMaterial({ color: 0x3a7d44, roughness: 0.8 });
        addPart(18, 16, 22, 0, 12, 0, blueGreen);
        addPart(6, 2, 6, -6, 18, -4, spot); addPart(6, 2, 6, 6, 18, 2, spot);
        addPart(12, 16, 12, 0, 24, -6, dgreen); addPart(8, 6, 8, 0, 36, -6, dgreen);
        addPart(16, 14, 16, 0, 24, 10, blueGreen);
        addPart(2, 2, 2, -4, 28, 18, blackMat); addPart(2, 2, 2, 4, 28, 18, blackMat);
        addPart(2, 2, 2, 0, 25, 18, blackMat);
        addPart(4, 4, 2, -4, 34, 10, blueGreen); addPart(4, 4, 2, 4, 34, 10, blueGreen);
        addPart(5, 8, 5, -6, 3, 8, blueGreen); addPart(5, 8, 5, 6, 3, 8, blueGreen);
        addPart(5, 8, 5, -6, 3, -8, blueGreen); addPart(5, 8, 5, 6, 3, -8, blueGreen);
    } else if (type === 'slowpoke') {
        heightOffset = 18;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffb6b6, roughness: 0.7 });
        const tailTip = new THREE.MeshPhysicalMaterial({ color: 0xff7070, roughness: 0.6 });
        addPart(22, 18, 34, 0, 16, 0, pink); addPart(18, 16, 18, 0, 26, 14, pink);
        addPart(2, 2, 2, -5, 28, 22, blackMat); addPart(2, 2, 2, 5, 28, 22, blackMat);
        addPart(6, 4, 4, 0, 24, 24, pink);
        addPart(6, 4, 4, -10, 30, 14, pink); addPart(6, 4, 4, 10, 30, 14, pink);
        addPart(4, 4, 24, 0, 16, -20, pink); addPart(6, 6, 6, 0, 16, -34, tailTip);
        addPart(8, 10, 8, -8, 3, 10, pink); addPart(8, 10, 8, 8, 3, 10, pink);
        addPart(8, 10, 8, -8, 3, -10, pink); addPart(8, 10, 8, 8, 3, -10, pink);
    } else if (type === 'marill') {
        heightOffset = 12;
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x5b9bd5, roughness: 0.5 });
        const lightBlue = new THREE.MeshPhysicalMaterial({ color: 0xadd8e6, roughness: 0.5 });
        addPart(20, 20, 20, 0, 12, 0, blue); addPart(16, 10, 4, 0, 12, 11, lightBlue);
        addPart(18, 18, 18, 0, 28, 0, blue);
        addPart(4, 4, 2, -5, 30, 9, blackMat); addPart(4, 4, 2, 5, 30, 9, blackMat);
        addPart(2, 2, 2, 0, 27, 10, blackMat);
        addPart(8, 8, 2, -8, 36, 0, blue); addPart(8, 8, 2, 8, 36, 0, blue);
        addPart(4, 4, 10, 0, 14, -12, blue); addPart(4, 4, 6, 4, 14, -20, blue);
        addPart(6, 6, 6, 4, 14, -26, lightBlue);
        addPart(6, 6, 6, -6, 3, 6, blue); addPart(6, 6, 6, 6, 3, 6, blue);
    } else if (type === 'togepi') {
        heightOffset = 14;
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfffacd, roughness: 0.6 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xff4444, roughness: 0.7 });
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x4488ff, roughness: 0.7 });
        addPart(16, 22, 16, 0, 12, 0, cream);
        addPart(5, 5, 2, -5, 18, 9, red); addPart(5, 5, 2, 5, 14, 9, blue); addPart(5, 5, 2, 0, 22, 9, red);
        addPart(14, 14, 14, 0, 28, 0, cream);
        addPart(2, 2, 2, -4, 32, 7, blackMat); addPart(2, 2, 2, 4, 32, 7, blackMat);
        addPart(2, 3, 2, 0, 29, 7, blackMat);
        addPart(2, 6, 2, -4, 38, 0, matBase); addPart(2, 8, 2, 0, 40, 0, matBase); addPart(2, 6, 2, 4, 38, 0, matBase);
        addPart(5, 4, 5, -6, 1, 3, cream); addPart(5, 4, 5, 6, 1, 3, cream);
    } else if (type === 'clefairy') {
        heightOffset = 16;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffafd7, roughness: 0.6 });
        const dpink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.7 });
        addPart(18, 18, 16, 0, 12, 0, pink); addPart(6, 8, 2, 0, 22, 8, pink);
        addPart(16, 16, 16, 0, 26, 2, pink);
        addPart(2, 2, 2, -4, 30, 9, blackMat); addPart(2, 2, 2, 4, 30, 9, blackMat);
        addPart(2, 2, 2, 0, 28, 9, blackMat);
        addPart(5, 8, 2, -5, 36, 2, pink); addPart(2, 3, 2, -5, 44, 2, blackMat);
        addPart(5, 8, 2, 5, 36, 2, pink); addPart(2, 3, 2, 5, 44, 2, blackMat);
        addPart(8, 10, 2, -10, 18, -6, dpink); addPart(8, 10, 2, 10, 18, -6, dpink);
        addPart(6, 8, 4, -8, 14, 8, pink); addPart(6, 8, 4, 8, 14, 8, pink);
        addPart(6, 6, 8, -5, 2, 5, pink); addPart(6, 6, 8, 5, 2, 5, pink);
        addPart(4, 4, 10, 0, 12, -10, dpink);
    } else if (type === 'wobbuffet') {
        heightOffset = 28;
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x3a86c8, roughness: 0.6 });
        const dblue = new THREE.MeshPhysicalMaterial({ color: 0x1a5a9a, roughness: 0.7 });
        addPart(20, 44, 16, 0, 24, 0, blue); addPart(18, 14, 14, 0, 50, 0, blue);
        addPart(16, 10, 3, 0, 44, 8, whiteMat);
        addPart(3, 3, 2, -4, 46, 9, blackMat); addPart(3, 3, 2, 4, 46, 9, blackMat);
        addPart(6, 3, 2, 0, 43, 9, blackMat);
        addPart(8, 8, 4, -12, 28, 0, blue); addPart(8, 8, 4, 12, 28, 0, blue);
        addPart(8, 8, 12, 0, 8, -12, dblue); addPart(8, 8, 8, 0, 8, -20, dblue);
        addPart(4, 2, 1, -2, 10, -24, blackMat); addPart(4, 2, 1, 2, 10, -24, blackMat);
        addPart(5, 2, 1, 0, 8, -24, blackMat);

    // ── 신규: 점프 그룹 ──
    } else if (type === 'kangaroo') {
        heightOffset = 28;
        const tan = new THREE.MeshPhysicalMaterial({ color: 0xc8933c, roughness: 0.8 });
        const light = new THREE.MeshPhysicalMaterial({ color: 0xe8c080, roughness: 0.7 });
        addPart(16, 20, 16, 0, 18, 0, tan);          // 몸통
        addPart(14, 16, 12, 0, 36, 4, tan);          // 상체
        addPart(12, 12, 12, 0, 50, 6, tan);          // 머리
        addPart(2, 2, 2, -4, 54, 12, blackMat); addPart(2, 2, 2, 4, 54, 12, blackMat); // 눈
        addPart(4, 12, 4, -4, 62, 6, tan); addPart(4, 12, 4, 4, 62, 6, tan); // 귀
        addPart(6, 14, 4, -10, 38, 2, tan); addPart(6, 14, 4, 10, 38, 2, tan); // 팔
        addPart(6, 16, 6, -7, 3, 4, tan); addPart(6, 16, 6, 7, 3, 4, tan);   // 뒷다리
        addPart(4, 6, 12, -6, 1, -10, tan); addPart(4, 6, 12, 6, 1, -10, tan); // 발
        addPart(6, 4, 24, 0, 16, -18, light);        // 꼬리 (육아낭 느낌)

    } else if (type === 'grasshopper') {
        heightOffset = 12;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x4caf50, roughness: 0.7 });
        const dgreen = new THREE.MeshPhysicalMaterial({ color: 0x2e7d32, roughness: 0.8 });
        addPart(10, 8, 28, 0, 8, 0, green);          // 몸통
        addPart(8, 8, 10, 0, 14, 18, green);         // 머리
        addPart(2, 2, 2, -3, 18, 22, blackMat); addPart(2, 2, 2, 3, 18, 22, blackMat); // 눈
        addPart(1, 1, 16, -4, 20, 14, dgreen); addPart(1, 1, 16, 4, 20, 14, dgreen);   // 더듬이
        addPart(4, 14, 4, -6, 3, 4, dgreen); addPart(4, 14, 4, 6, 3, 4, dgreen);       // 도약 뒷다리
        addPart(4, 8, 4, -5, 3, -4, green); addPart(4, 8, 4, 5, 3, -4, green);         // 앞다리

    } else if (type === 'frog') {
        heightOffset = 10;
        const fgreen = new THREE.MeshPhysicalMaterial({ color: 0x66bb6a, roughness: 0.6 });
        const belly = new THREE.MeshPhysicalMaterial({ color: 0xc8e6c9, roughness: 0.5 });
        addPart(20, 12, 20, 0, 8, 0, fgreen);        // 몸통
        addPart(14, 6, 8, 0, 12, -2, belly);         // 배
        addPart(18, 12, 16, 0, 18, 8, fgreen);       // 머리
        addPart(6, 6, 4, -8, 24, 10, fgreen); addPart(6, 6, 4, 8, 24, 10, fgreen); // 눈 볼록
        addPart(2, 2, 2, -8, 26, 13, blackMat); addPart(2, 2, 2, 8, 26, 13, blackMat); // 눈
        addPart(6, 4, 14, -12, 4, -4, fgreen); addPart(6, 4, 14, 12, 4, -4, fgreen);   // 뒷다리
        addPart(8, 3, 6, -14, 3, -14, fgreen); addPart(8, 3, 6, 14, 3, -14, fgreen);   // 발

    // ── 신규: 벽타기 그룹 ──
    } else if (type === 'snail') {
        heightOffset = 10;
        const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xa0522d, roughness: 0.6 });
        const bodyMat  = new THREE.MeshPhysicalMaterial({ color: 0xd4a843, roughness: 0.5 });
        addPart(12, 6, 24, 0, 4, 0, bodyMat);        // 몸통
        addPart(10, 8, 10, 0, 10, 4, bodyMat);       // 머리
        addPart(2, 8, 2, -3, 18, 8, bodyMat); addPart(2, 8, 2, 3, 18, 8, bodyMat); // 더듬이
        addPart(2, 2, 2, -3, 26, 8, blackMat); addPart(2, 2, 2, 3, 26, 8, blackMat); // 눈
        addPart(16, 14, 18, 0, 12, -6, shellMat);    // 껍데기 하단
        addPart(12, 10, 14, 0, 20, -8, shellMat);    // 껍데기 중단
        addPart(8, 6, 10, 0, 28, -8, matAcc);        // 껍데기 상단 강조

    } else if (type === 'lizard') {
        heightOffset = 8;
        const liz = new THREE.MeshPhysicalMaterial({ color: 0x8bc34a, roughness: 0.7 });
        const dliz = new THREE.MeshPhysicalMaterial({ color: 0x558b2f, roughness: 0.8 });
        addPart(10, 6, 36, 0, 4, 0, liz);            // 몸통
        addPart(12, 8, 12, 0, 8, 20, liz);           // 머리
        addPart(2, 2, 2, -4, 12, 25, blackMat); addPart(2, 2, 2, 4, 12, 25, blackMat); // 눈
        addPart(2, 2, 16, 0, 4, -26, dliz);          // 꼬리
        addPart(4, 4, 4, -7, 4, 12, liz); addPart(4, 4, 4, 7, 4, 12, liz);   // 앞다리
        addPart(4, 4, 4, -7, 4, -8, liz); addPart(4, 4, 4, 7, 4, -8, liz);   // 뒷다리

    // ── 신규: 육식동물 그룹 ──
    } else if (type === 'lion') {
        heightOffset = 24;
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xe8a820, roughness: 0.7 });
        const mane = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        const tan  = new THREE.MeshPhysicalMaterial({ color: 0xf5c842, roughness: 0.6 });
        addPart(22, 18, 38, 0, 20, 0, gold);         // 몸통
        addPart(20, 20, 20, 0, 28, 26, mane);        // 갈기
        addPart(14, 14, 14, 0, 34, 34, gold);        // 머리
        addPart(2, 2, 2, -4, 36, 40, blackMat); addPart(2, 2, 2, 4, 36, 40, blackMat); // 눈
        addPart(4, 4, 2, 0, 32, 42, tan);            // 코
        const tail = addPart(4, 24, 4, 0, 22, -20, gold); tail.rotation.x = -Math.PI / 5;
        addPart(6, 6, 6, 0, 18, -38, mane);         // 꼬리 끝 솜
        addPart(6, 16, 6, -8, 6, 12, gold); addPart(6, 16, 6, 8, 6, 12, gold);   // 앞다리
        addPart(6, 16, 6, -8, 6, -12, gold); addPart(6, 16, 6, 8, 6, -12, gold); // 뒷다리

    } else if (type === 'bear') {
        heightOffset = 30;
        const brn  = new THREE.MeshPhysicalMaterial({ color: 0x6b3a1f, roughness: 0.9 });
        const lbrn = new THREE.MeshPhysicalMaterial({ color: 0xa0602a, roughness: 0.8 });
        // 2족 보행: 몸통 직립
        addPart(22, 28, 18, 0, 26, 0, brn);          // 몸통 (직립)
        addPart(16, 8, 12, 0, 22, 0, lbrn);          // 배
        addPart(20, 18, 18, 0, 52, 2, brn);          // 머리
        addPart(10, 6, 6, 0, 46, 10, lbrn);         // 주둥이
        addPart(2, 2, 2, -5, 54, 11, blackMat); addPart(2, 2, 2, 5, 54, 11, blackMat); // 눈
        addPart(6, 6, 4, -8, 62, 2, brn); addPart(6, 6, 4, 8, 62, 2, brn); // 귀
        // 팔 (옆으로 뻗음)
        const lArm = addPart(8, 22, 8, -18, 36, 0, brn); lArm.rotation.z =  Math.PI / 6;
        const rArm = addPart(8, 22, 8,  18, 36, 0, brn); rArm.rotation.z = -Math.PI / 6;
        // 뒷다리 (직립)
        addPart(8, 22, 8, -7, 6, 0, brn); addPart(8, 22, 8, 7, 6, 0, brn);
    }

    state.scene.add(animalGroup);

    const hw = (24 * u) / 2;
    const hh = heightOffset * (voxelSize / 20); // 메시 오프셋과 동일한 halfHeight로 맞춤
    const hd = (40 * u) / 2;
    const boxShape = new CANNON.Box(new CANNON.Vec3(hw, hh, hd));

    const spawnX = (Math.random() - 0.5) * 1600;
    const spawnZ = (Math.random() - 0.5) * 1600;
    const spawnY = 400 + Math.random() * 200;

    const body = new CANNON.Body({
        mass: 10,
        shape: boxShape,
        position: new CANNON.Vec3(spawnX, spawnY, spawnZ),
        material: state.animalMaterial || new CANNON.Material(),
        fixedRotation: true,
        linearDamping: 0.95
    });

    if (state.world) state.world.addBody(body);

    const animGroup = ANIM_TYPE[type] || 'quadruped';
    const baseSpeed = 300 + Math.random() * 300;
    const speed = baseSpeed * (SPEED_MULT[animGroup] || 1.0);

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
        animGroup,
        animTime: 0,
        _animYOffset: 0,
        baseScale: animalGroup.scale.clone(),
        clickActionTimer: 0,
        clickActionPhase: 0,
        clickActionType: CLICK_ACTION_MAP[animGroup] || 'spin',
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
}

function removeOldestAnimal() {
    const animal = animals.shift();
    if (animal) {
        if (animal.mesh) state.scene.remove(animal.mesh);
        if (animal.body && state.world) state.world.removeBody(animal.body);
    }
}

function getAnimalFullHeight(animal) {
    return animal.heightOffset * (voxelSize / 10);
}

function getCurrentStandingGroundY(animal) {
    if (!animal.body) return GROUND_BASE_HEIGHT;
    const halfHeight = animal.heightOffset * (voxelSize / 20);
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
        if (animal.jumpCooldown > 0) animal.jumpCooldown -= dt;

        // ── 잡힌 상태 ──
        if (animal.grabbed) {
            if (animal.body) { animal.body.velocity.set(0, 0, 0); animal.body.angularVelocity.set(0, 0, 0); }
            return;
        }

        // ── 착지 감지 ──
        if (animal.state === 'falling') {
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
        } else {
            const halfHeight = animal.heightOffset * (voxelSize / 20);
            const groundY = getCurrentStandingGroundY(animal);
            const targetFood = findNearestFood(animal);

            // ── 육식동물 도주 방향 계산 ──
            let fleeDir = null;
            if (!animal.isCarnivore && animal.body) {
                for (const pred of animals) {
                    if (!pred.isCarnivore || pred.grabbed || !pred.body) continue;
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
                animal.body.velocity.x = fleeDir.x * animal.speed * 1.8;
                animal.body.velocity.z = fleeDir.z * animal.speed * 1.8;
                animal.mesh.rotation.y = Math.atan2(fleeDir.x, fleeDir.z);
                animal.state = 'walking';
                animal.timer = 1.2;
            }
            // ── 먹이 추적 AI ──
            else if (targetFood && animal.clickActionTimer <= 0) {
                const dx = targetFood.position.x - animal.body.position.x;
                const dz = targetFood.position.z - animal.body.position.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const heightDiff = Math.abs(targetFood.position.y - animal.body.position.y);

                if (dist < EAT_RADIUS && heightDiff < voxelSize * 1.5) {
                    // 먹기 시작!
                    if (!targetFood.eaten) {
                        targetFood.eaten = true;
                        targetFood.consumeTimer = 2.0;
                    }
                    animal.isEating = true;
                    animal.eatTimer = 1.2;
                    animal.state = 'idle';
                    if (animal.body) { animal.body.velocity.x = 0; animal.body.velocity.z = 0; }
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
                            const blockTop = wallHit.object.position.y + voxelSize / 2;

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

                    let blockForward = false;
                    if (predictX > boardLimit || predictX < -boardLimit) blockForward = true;
                    if (predictZ > boardLimit || predictZ < -boardLimit) blockForward = true;
                    if (Math.abs(nextGroundY - groundY) > maxStep) blockForward = true;
                    const nextCeilingY = getCeilingHeightAbove(predictX, nextGroundY + 0.1, predictZ);
                    if (nextCeilingY - nextGroundY < fullHeight * 0.95) blockForward = true;

                    // ── HOP/HEAVY 전방 벽 감지 (배회 모드) ──
                    if (!blockForward && animal.body.velocity.y <= 80 && animal.jumpCooldown <= 0) {
                        const wHit = probeAhead(animal.body.position, animal.targetDir, groundY, halfHeight);
                        if (wHit) {
                            const wThick = countThickness(wHit, animal.targetDir);
                            const wTop = wHit.object.position.y + voxelSize / 2;
                            if (animal.animGroup === 'HOP' && wTop <= groundY + voxelSize * 5 && wThick <= 4) {
                                // HOP: 점프
                                animal.body.velocity.y = 1200;
                                animal.jumpCooldown = 1.5;
                                animal.body.velocity.x = animal.targetDir.x * animal.speed;
                                animal.body.velocity.z = animal.targetDir.z * animal.speed;
                            } else if (animal.animGroup === 'HEAVY') {
                                // HEAVY: 2단 블록 폭발 파괴
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
    });
}
