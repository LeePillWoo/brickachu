import * as THREE from 'three';
import { createSoftBoxGeometry } from './model-utils.js';
import { state, objects, voxelSize } from './state.js';
import { animals, MAX_ANIMALS, registerCustomAnimal, removeAnimalImmediately } from './entities.js';
import { detachVoxelsForLiving, pushHistory } from './scene.js';
import { playSound } from './sound.js';

export const MAX_LIVING_BLOCKS = 96;
export const MAX_LIVING_SPAN = voxelSize * 12;
let nextLivingId = 1;
const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const cellKey = (x, y, z) => `${Math.round(x / voxelSize * 1000)},${Math.round(y / voxelSize * 1000)},${Math.round(z / voxelSize * 1000)}`;

// One extra block reports overflow while keeping hover work bounded for huge builds.
export function collectConnectedBlocks(seed) {
    if (!seed || seed === state.plane || !objects.includes(seed)) return [];
    const byCell = new Map(objects.filter(block => block !== state.plane).map(block => [
        cellKey(block.position.x, block.position.y, block.position.z), block
    ]));
    const connected = [seed];
    const visited = new Set([seed]);
    for (let index = 0; index < connected.length; index++) {
        const { x, y, z } = connected[index].position;
        for (const [dx, dy, dz] of directions) {
            const neighbor = byCell.get(cellKey(x + dx * voxelSize, y + dy * voxelSize, z + dz * voxelSize));
            if (!neighbor || visited.has(neighbor)) continue;
            visited.add(neighbor);
            connected.push(neighbor);
            if (connected.length > MAX_LIVING_BLOCKS) return connected;
        }
    }
    return connected;
}

const abilities = {
    HOP: { abilityName: '폴짝 점프', abilityDescription: '키다리 친구! 높은 블록을 폴짝 넘고, 누르면 공중에서 빙글!' },
    SNEAK: { abilityName: '쏙쏙 기어가기', abilityDescription: '납작한 친구! 낮은 틈으로 기어가고 벽도 타요. 누르면 쌩!' },
    HEAVY: { abilityName: '쿵쿵 발구르기', abilityDescription: '덩치 큰 친구! 먹이 앞의 블록을 부수고, 누르면 땅이 쿵쿵!' },
    WADDLE: { abilityName: '뒤뚱 댄스', abilityDescription: '뒤뚱뒤뚱 친구! 누르면 빙글빙글 신나는 춤을 춰요!' }
};

export function classifyLivingShape(size, blockCount) {
    const span = Math.max(size.x, size.z);
    if (size.y >= span * 1.5) return 'HOP';
    if (size.y <= span * 0.5) return 'SNEAK';
    if (blockCount >= 12 || size.y >= voxelSize * 3) return 'HEAVY';
    return 'WADDLE';
}

function freezeDescriptor(descriptor) {
    for (const block of descriptor.blocks) {
        Object.freeze(block.pos);
        Object.freeze(block);
    }
    ['blocks', 'origin', 'size', 'eyePosition', 'eyeNormal'].forEach(key => Object.freeze(descriptor[key]));
    return Object.freeze(descriptor);
}

function cardinalNormal(normal) {
    if (!normal || !Number.isFinite(normal.x + normal.y + normal.z) || normal.lengthSq() < 0.1) {
        return new THREE.Vector3(0, 0, 1);
    }
    const axis = ['x', 'y', 'z'].sort((a, b) => Math.abs(normal[b]) - Math.abs(normal[a]))[0];
    const result = new THREE.Vector3();
    result[axis] = Math.sign(normal[axis]);
    return result;
}

function describeBuild(blocks, seed, normal) {
    const bounds = new THREE.Box3();
    blocks.forEach(block => bounds.expandByPoint(block.position));
    bounds.min.addScalar(-voxelSize / 2);
    bounds.max.addScalar(voxelSize / 2);
    const size = bounds.getSize(new THREE.Vector3());
    const origin = bounds.getCenter(new THREE.Vector3());
    origin.y = bounds.min.y;
    const face = cardinalNormal(normal);
    const yaw = face.y === 0 ? Math.atan2(face.x, face.z) : 0;
    const toLocal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    const local = point => point.clone().sub(origin).applyQuaternion(toLocal).toArray().map(value => Math.round(value * 1000) / 1000);
    const animGroup = classifyLivingShape(size, blocks.length);
    const descriptor = {
        id: `living-${Date.now().toString(36)}-${nextLivingId++}`,
        origin: origin.toArray(), size: size.toArray(), yaw, animGroup,
        ...abilities[animGroup],
        eyePosition: local(seed.position.clone().addScaledVector(face, voxelSize / 2 + 1)),
        eyeNormal: face.clone().applyQuaternion(toLocal).toArray(),
        blocks: blocks.map(block => ({
            pos: local(block.position), slot: block.userData.slot,
            color: block.material.color.getHex(),
            roughness: block.material.roughness ?? 0.55,
            metalness: block.material.metalness ?? 0
        }))
    };
    return freezeDescriptor(descriptor);
}

function makeEyes(descriptor) {
    const eyes = new THREE.Group();
    eyes.name = 'living-eyes';
    eyes.position.fromArray(descriptor.eyePosition);
    eyes.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...descriptor.eyeNormal).normalize());
    const eyeGeometry = createSoftBoxGeometry(17.6, 21, 10, 5);
    const pupilGeometry = createSoftBoxGeometry(8.2, 10.4, 3, 2.5);
    const glintGeometry = createSoftBoxGeometry(2.5, 2.5, 0.8, 0.7);
    const white = new THREE.MeshStandardMaterial({ color: 0xfff9ee, roughness: 0.35 });
    const black = new THREE.MeshStandardMaterial({ color: 0x172133, roughness: 0.3 });
    const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const side of [-1, 1]) {
        const eye = new THREE.Group();
        eye.position.x = side * voxelSize * 0.205;
        const sclera = new THREE.Mesh(eyeGeometry, white);
        sclera.castShadow = true;
        eye.add(sclera);
        const pupil = new THREE.Mesh(pupilGeometry, black);
        pupil.position.set(-side * 0.6, 0, 5.4);
        eye.add(pupil);
        const glint = new THREE.Mesh(glintGeometry, shine);
        glint.position.set(-side * 0.6 - 1.1, 2.0, 7.05);
        eye.add(glint);
        const sparkle = new THREE.Mesh(glintGeometry, shine);
        sparkle.position.set(-side * 0.6 + 1.8, -2.1, 7.05);
        sparkle.scale.setScalar(0.4);
        eye.add(sparkle);
        eyes.add(eye);
    }
    return eyes;
}

function createFromDescriptor(saved) {
    const descriptor = Object.isFrozen(saved) ? saved : freezeDescriptor(saved);
    const mesh = new THREE.Group();
    mesh.name = 'living-block-friend';
    // Living meshes own their resources; deleting one never disposes the palette.
    const geometry = state.cubeGeo.clone();
    const ownedMaterials = new Map();
    for (const block of descriptor.blocks) {
        const materialKey = `${block.color}:${block.roughness}:${block.metalness}`;
        if (!ownedMaterials.has(materialKey)) ownedMaterials.set(materialKey, new THREE.MeshPhysicalMaterial({
            color: block.color, roughness: block.roughness, metalness: block.metalness
        }));
        const voxel = new THREE.Mesh(geometry, ownedMaterials.get(materialKey));
        voxel.name = 'living-voxel';
        voxel.position.fromArray(block.pos);
        voxel.castShadow = true;
        voxel.receiveShadow = true;
        mesh.add(voxel);
    }
    const eyes = makeEyes(descriptor);
    mesh.add(eyes);
    return registerCustomAnimal(mesh, {
        position: new THREE.Vector3(...descriptor.origin),
        size: new THREE.Vector3(...descriptor.size), blocks: descriptor.blocks,
        animGroup: descriptor.animGroup, yaw: descriptor.yaw,
        livingDescriptor: descriptor, eyes
    });
}

export function awakenBlocks(seed, normal = new THREE.Vector3(0, 0, 1)) {
    const blocks = collectConnectedBlocks(seed);
    if (!blocks.length) return { ok: false, reason: '눈을 붙일 블록을 눌러 주세요!' };
    if (blocks.length > MAX_LIVING_BLOCKS) return { ok: false, reason: `너무 커요! ${MAX_LIVING_BLOCKS}개 이하로 떨어뜨려 만들어 주세요.` };
    const bounds = new THREE.Box3();
    blocks.forEach(block => bounds.expandByPoint(block.position));
    const span = bounds.getSize(new THREE.Vector3()).addScalar(voxelSize);
    if (Math.max(span.x, span.y, span.z) > MAX_LIVING_SPAN) {
        return { ok: false, reason: '너무 길쭉해요! 가로·세로·높이를 12칸 안으로 만들어 주세요.' };
    }
    if (animals.length >= MAX_ANIMALS) return { ok: false, reason: '놀이터가 꽉 찼어요! 친구를 조금 줄여 주세요.' };
    const descriptor = describeBuild(blocks, seed, normal);
    pushHistory();
    detachVoxelsForLiving(blocks);
    const animal = createFromDescriptor(descriptor);
    pushHistory();
    playSound('animal-spawn');
    return { ok: true, animal, reason: descriptor.abilityDescription };
}

// Descriptors contain creation geometry only. Wandering or transforming does not
// create history noise, and unrelated edits cannot teleport an existing friend.
export function snapshotLivingAnimals() {
    return animals.filter(animal => animal.livingId).map(animal => animal.livingDescriptor);
}

export function reconcileLivingAnimals(descriptors = []) {
    const wanted = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
    for (const animal of [...animals]) {
        if (animal.livingId && !wanted.has(animal.livingId)) removeAnimalImmediately(animal);
    }
    const existing = new Set(animals.filter(animal => animal.livingId).map(animal => animal.livingId));
    for (const descriptor of wanted.values()) {
        // Restoring an edit must preserve ordinary animals spawned since then.
        // History may temporarily exceed the spawn cap; the next spawn normalizes it.
        if (!existing.has(descriptor.id)) createFromDescriptor(descriptor);
    }
}
