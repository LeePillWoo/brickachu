import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, voxelSize } from './state.js';

export const animals = [];
export const dogs = animals; // Aliased for backwards compatibility in main.js
const MAX_ANIMALS = 10;

// Helper to pick a completely random bright color
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
    const u = voxelSize / 20; // 1/20th scale unit

    const types = [
        'dog', 'cat', 'rabbit', 'sheep', 'snake', 'horse', 'pikachu', 'squirtle', 'charmander',
        'meowth', 'snorlax', 'jigglypuff', 'diglett', 'porygon', 'ditto',
        'lion', 'elephant', 'giraffe', 'penguin', 'crocodile', 'pig', 'turtle'
    ];
    const type = types[Math.floor(Math.random() * types.length)];

    // Randomize base colors for this specific animal instance
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
        animalGroup.add(mesh);
        return mesh;
    }

    // Build models based on type
    let heightOffset = 10;

    if (type === 'dog') {
        addPart(10, 8, 16, 0, 8, 0); // Body
        addPart(8, 8, 8, 0, 16, 12); // Head
        addPart(4, 3, 4, 0, 14, 18, blackMat); // Snout
        addPart(2, 4, 2, -3, 22, 12, matSec); // L Ear
        addPart(2, 4, 2, 3, 22, 12, matSec); // R Ear
        const tail = addPart(2, 6, 2, 0, 14, -8, matAcc);
        tail.rotation.x = -Math.PI / 4;
        addPart(3, 6, 3, -3, 3, 5); addPart(3, 6, 3, 3, 3, 5);
        addPart(3, 6, 3, -3, 3, -5); addPart(3, 6, 3, 3, 3, -5);
    } else if (type === 'cat') {
        heightOffset = 8;
        addPart(8, 6, 12, 0, 6, 0); // Body
        addPart(6, 6, 6, 0, 12, 9); // Head
        addPart(2, 2, 2, 0, 10, 13, matSec); // Nose
        addPart(2, 3, 2, -2, 16, 10, matAcc); // L Ear (pointy)
        addPart(2, 3, 2, 2, 16, 10, matAcc); // R Ear (pointy)
        const tail = addPart(2, 10, 2, 0, 12, -6, matSec);
        tail.rotation.x = Math.PI / 6; // High tail
        addPart(2, 4, 2, -2, 2, 4); addPart(2, 4, 2, 2, 2, 4);
        addPart(2, 4, 2, -2, 2, -4); addPart(2, 4, 2, 2, 2, -4);
    } else if (type === 'rabbit') {
        heightOffset = 6;
        addPart(6, 6, 8, 0, 5, 0, whiteMat); // Body
        addPart(5, 5, 5, 0, 10, 5, whiteMat); // Head
        addPart(2, 8, 2, -1.5, 16, 6, matSec); // L Ear (long)
        addPart(2, 8, 2, 1.5, 16, 6, matSec); // R Ear (long)
        addPart(3, 3, 3, 0, 6, -5, whiteMat); // Tail (fluff)
        addPart(2, 3, 2, -2, 1.5, 3, whiteMat); addPart(2, 3, 2, 2, 1.5, 3, whiteMat); // Front
        addPart(2, 4, 4, -2, 2, -3, whiteMat); addPart(2, 4, 4, 2, 2, -3, whiteMat); // Back (big feet)
    } else if (type === 'sheep') {
        heightOffset = 10;
        addPart(12, 10, 14, 0, 9, 0, whiteMat); // Fluffy Body
        addPart(6, 6, 8, 0, 14, 11, blackMat); // Head (black face)
        addPart(2, 2, 4, -4, 14, 10, whiteMat); // L Ear
        addPart(2, 2, 4, 4, 14, 10, whiteMat); // R Ear
        addPart(2, 5, 2, -3, 2.5, 5, blackMat); addPart(2, 5, 2, 3, 2.5, 5, blackMat); // Legs
        addPart(2, 5, 2, -3, 2.5, -5, blackMat); addPart(2, 5, 2, 3, 2.5, -5, blackMat);
    } else if (type === 'snake') {
        heightOffset = 3;
        addPart(4, 3, 24, 0, 1.5, 0, matBase); // Long Body
        addPart(5, 4, 6, 0, 2, 15, matSec); // Head
        addPart(2, 1, 4, 0, 2, 19, matAcc); // Tongue
    } else if (type === 'horse') {
        heightOffset = 16;
        addPart(10, 10, 20, 0, 16, 0); // Body
        addPart(6, 12, 6, 0, 24, 12); // Neck
        addPart(6, 6, 10, 0, 28, 16); // Head
        addPart(2, 12, 4, 0, 24, 9, matSec); // Mane
        const tail = addPart(3, 12, 3, 0, 16, -10, matSec);
        tail.rotation.x = -Math.PI / 8;
        addPart(3, 12, 3, -3.5, 6, 8, matAcc); addPart(3, 12, 3, 3.5, 6, 8, matAcc); // Legs
        addPart(3, 12, 3, -3.5, 6, -8, matAcc); addPart(3, 12, 3, 3.5, 6, -8, matAcc);
    } else if (type === 'pikachu') {
        heightOffset = 8;
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.6 });
        const red = new THREE.MeshPhysicalMaterial({ color: 0xff0000, roughness: 0.8 });
        addPart(8, 10, 8, 0, 5, 0, yellow); // Body
        addPart(8, 8, 8, 0, 14, 2, yellow); // Head
        addPart(2, 2, 1, -3, 13, 6, red); addPart(2, 2, 1, 3, 13, 6, red); // Cheeks
        addPart(2, 8, 2, -3, 20, 2, yellow); addPart(2, 2, 2, -3, 24, 2, blackMat); // L Ear
        addPart(2, 8, 2, 3, 20, 2, yellow); addPart(2, 2, 2, 3, 24, 2, blackMat); // R Ear
        const pTail = addPart(2, 10, 6, 0, 8, -6, yellow); pTail.rotation.x = -Math.PI / 4; // Tail
        addPart(2, 3, 3, -2, 1.5, 2, yellow); addPart(2, 3, 3, 2, 1.5, 2, yellow); // Feet
    } else if (type === 'squirtle') {
        heightOffset = 8;
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x4fc3f7, roughness: 0.6 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8d6e63, roughness: 0.8 });
        addPart(8, 8, 6, 0, 6, 0, blue); // Body
        addPart(10, 10, 4, 0, 6, -2, brown); // Shell
        addPart(8, 8, 8, 0, 14, 2, blue); // Head
        addPart(3, 3, 3, -4, 8, 4, blue); addPart(3, 3, 3, 4, 8, 4, blue); // Arms
        addPart(3, 4, 4, -3, 2, 2, blue); addPart(3, 4, 4, 3, 2, 2, blue); // Legs
        const sTail = addPart(4, 4, 6, 0, 4, -6, blue); sTail.rotation.x = Math.PI / 4;
    } else if (type === 'charmander') {
        heightOffset = 8;
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xff9800, roughness: 0.6 });
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffeb3b, roughness: 0.8 });
        const fire = new THREE.MeshPhysicalMaterial({ color: 0xff3d00, roughness: 0.2, emissive: 0xff3d00 });
        addPart(8, 9, 8, 0, 6, 0, orange); // Body
        addPart(6, 7, 1, 0, 5, 4, yellow); // Belly
        addPart(8, 8, 8, 0, 14, 2, orange); // Head
        addPart(2, 4, 2, -4, 8, 4, orange); addPart(2, 4, 2, 4, 8, 4, orange); // Arms
        addPart(3, 4, 4, -3, 2, 2, orange); addPart(3, 4, 4, 3, 2, 2, orange); // Legs
        const cTail = addPart(3, 3, 10, 0, 4, -6, orange); cTail.rotation.x = Math.PI / 6;
        addPart(2, 4, 2, 0, 8, -12, fire); // Tail flame
    } else if (type === 'meowth') {
        heightOffset = 8;
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xfffdd0, roughness: 0.7 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.7 });
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.3 });
        addPart(6, 8, 6, 0, 6, 0, cream); // Body
        addPart(8, 8, 6, 0, 14, 1, cream); // Head
        addPart(2, 4, 2, -3, 19, 1, brown); addPart(2, 4, 2, 3, 19, 1, brown); // Ears
        addPart(3, 4, 1, 0, 16, 4, gold); // Coin
        addPart(2, 6, 2, -4, 8, 1, cream); addPart(2, 6, 2, 4, 8, 1, cream); // Arms
        addPart(3, 3, 4, -2.5, 1.5, 2, brown); addPart(3, 3, 4, 2.5, 1.5, 2, brown); // Feet
        const mTail = addPart(2, 10, 2, 0, 6, -4, brown); mTail.rotation.x = Math.PI / 8; // Tail
    } else if (type === 'snorlax') {
        heightOffset = 12;
        const teal = new THREE.MeshPhysicalMaterial({ color: 0x008080, roughness: 0.8 });
        const cream = new THREE.MeshPhysicalMaterial({ color: 0xf5f5dc, roughness: 0.8 });
        addPart(20, 18, 16, 0, 10, 0, teal); // Big body
        addPart(16, 14, 4, 0, 9, 8, cream); // Belly
        addPart(12, 10, 10, 0, 24, 0, teal); // Head
        addPart(8, 6, 2, 0, 24, 5, cream); // Face mask
        addPart(3, 4, 3, -4, 30, 0, teal); addPart(3, 4, 3, 4, 30, 0, teal); // Ears
        addPart(5, 8, 5, -12, 12, 2, teal); addPart(5, 8, 5, 12, 12, 2, teal); // Arms
        addPart(5, 5, 6, -6, 2.5, 6, cream); addPart(5, 5, 6, 6, 2.5, 6, cream); // Feet
    } else if (type === 'jigglypuff') {
        heightOffset = 6;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffb6c1, roughness: 0.7 });
        addPart(12, 12, 12, 0, 6, 0, pink); // Round body
        addPart(3, 4, 3, -3, 13, 0, pink); addPart(3, 4, 3, 3, 13, 0, pink); // Ears
        addPart(4, 3, 3, 0, 13, 4, pink); // Hair tuft
        addPart(3, 3, 3, -6, 6, 2, pink); addPart(3, 3, 3, 6, 6, 2, pink); // Arms
        addPart(4, 2, 5, -3, 1, 4, pink); addPart(4, 2, 5, 3, 1, 4, pink); // Feet
    } else if (type === 'diglett') {
        heightOffset = 4;
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const dirt = new THREE.MeshPhysicalMaterial({ color: 0x5c4033, roughness: 1.0 });
        addPart(14, 2, 14, 0, 1, 0, dirt); // Dirt mound
        addPart(8, 10, 8, 0, 6, 0, brown); // Body sticking out
        addPart(4, 2, 3, 0, 8, 4, pink); // Big nose
    } else if (type === 'porygon') {
        heightOffset = 8;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xff69b4, roughness: 0.5 });
        const blue = new THREE.MeshPhysicalMaterial({ color: 0x00bfff, roughness: 0.5 });
        addPart(8, 8, 8, 0, 6, 0, pink); // Body
        addPart(6, 6, 6, 0, 14, 3, pink); // Head
        addPart(4, 4, 8, 0, 12, 9, blue); // Snout
        addPart(6, 8, 4, -6, 6, 0, blue); addPart(6, 8, 4, 6, 6, 0, blue); // Legs
        const pTail = addPart(4, 4, 6, 0, 6, -6, blue); pTail.rotation.x = -Math.PI / 4; // Tail
    } else if (type === 'ditto') {
        heightOffset = 4;
        const purple = new THREE.MeshPhysicalMaterial({ color: 0xdda0dd, roughness: 0.4, transmission: 0.2 });
        addPart(12, 6, 10, 0, 3, 0, purple); // Blob base
        addPart(8, 6, 8, 0, 7, 0, purple); // Blob top
        addPart(4, 4, 4, -5, 5, 2, purple); addPart(4, 4, 4, 5, 5, 2, purple); // Little arms
    } else if (type === 'lion') {
        heightOffset = 12;
        const gold = new THREE.MeshPhysicalMaterial({ color: 0xdaa520, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(10, 10, 18, 0, 12, 0, gold); // Body
        addPart(14, 14, 6, 0, 16, 10, brown); // Mane
        addPart(8, 8, 8, 0, 16, 14, gold); // Head
        addPart(4, 4, 4, 0, 14, 18, blackMat); // Snout
        const tail = addPart(2, 10, 2, 0, 12, -10, gold); tail.rotation.x = -Math.PI / 6;
        addPart(3, 8, 3, -3.5, 4, 7, gold); addPart(3, 8, 3, 3.5, 4, 7, gold); // Front legs
        addPart(3, 8, 3, -3.5, 4, -7, gold); addPart(3, 8, 3, 3.5, 4, -7, gold); // Back legs
    } else if (type === 'elephant') {
        heightOffset = 18;
        const grey = new THREE.MeshPhysicalMaterial({ color: 0x808080, roughness: 0.8 });
        addPart(18, 16, 24, 0, 16, 0, grey); // Huge body
        addPart(14, 14, 14, 0, 20, 16, grey); // Head
        addPart(2, 20, 2, 0, 12, 24, grey); // Trunk
        addPart(10, 14, 2, -12, 18, 14, grey); addPart(10, 14, 2, 12, 18, 14, grey); // Big ears
        addPart(6, 10, 6, -6, 5, 8, grey); addPart(6, 10, 6, 6, 5, 8, grey); // Front legs
        addPart(6, 10, 6, -6, 5, -8, grey); addPart(6, 10, 6, 6, 5, -8, grey); // Back legs
    } else if (type === 'giraffe') {
        heightOffset = 30; // Very tall
        const yellow = new THREE.MeshPhysicalMaterial({ color: 0xffd700, roughness: 0.8 });
        const brown = new THREE.MeshPhysicalMaterial({ color: 0x8b4513, roughness: 0.9 });
        addPart(10, 10, 16, 0, 20, 0, yellow); // Body
        addPart(4, 20, 6, 0, 32, 10, yellow); // Long neck
        addPart(6, 6, 10, 0, 42, 14, yellow); // Head
        addPart(2, 3, 2, -2, 46, 12, brown); addPart(2, 3, 2, 2, 46, 12, brown); // Ossicones (horns)
        addPart(3, 18, 3, -3.5, 9, 6, yellow); addPart(3, 18, 3, 3.5, 9, 6, yellow); // Front tall legs
        addPart(3, 18, 3, -3.5, 9, -6, yellow); addPart(3, 18, 3, 3.5, 9, -6, yellow); // Back tall legs
    } else if (type === 'penguin') {
        heightOffset = 8;
        const black = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.6 });
        const white = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.8 });
        const orange = new THREE.MeshPhysicalMaterial({ color: 0xffa500, roughness: 0.6 });
        addPart(10, 14, 8, 0, 8, 0, black); // Body
        addPart(8, 12, 2, 0, 8, 4.5, white); // White belly
        addPart(8, 8, 8, 0, 18, 0, black); // Head
        addPart(6, 6, 2, 0, 18, 4.5, white); // White face
        addPart(4, 2, 4, 0, 16, 6, orange); // Beak
        addPart(2, 10, 4, -6, 10, 0, black); addPart(2, 10, 4, 6, 10, 0, black); // Flippers
        addPart(4, 2, 6, -3, 1, 3, orange); addPart(4, 2, 6, 3, 1, 3, orange); // Feet
    } else if (type === 'crocodile') {
        heightOffset = 3;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x2e8b57, roughness: 0.9 });
        addPart(12, 4, 20, 0, 2, 0, green); // Flat body
        addPart(10, 4, 12, 0, 2, 16, green); // Long snout
        addPart(8, 4, 18, 0, 2, -18, green); // Tail
        addPart(4, 3, 4, -8, 1.5, 6, green); addPart(4, 3, 4, 8, 1.5, 6, green); // Front legs
        addPart(4, 3, 4, -8, 1.5, -6, green); addPart(4, 3, 4, 8, 1.5, -6, green); // Back legs
    } else if (type === 'pig') {
        heightOffset = 6;
        const pink = new THREE.MeshPhysicalMaterial({ color: 0xffc0cb, roughness: 0.8 });
        addPart(12, 10, 16, 0, 7, 0, pink); // Plump body
        addPart(8, 8, 8, 0, 12, 10, pink); // Head
        addPart(4, 4, 2, 0, 10, 15, pink); // Snout
        addPart(2, 3, 2, -3, 16, 8, pink); addPart(2, 3, 2, 3, 16, 8, pink); // Ears
        addPart(3, 4, 3, -4, 2, 5, pink); addPart(3, 4, 3, 4, 2, 5, pink); // Front legs
        addPart(3, 4, 3, -4, 2, -5, pink); addPart(3, 4, 3, 4, 2, -5, pink); // Back legs
    } else if (type === 'turtle') {
        heightOffset = 4;
        const green = new THREE.MeshPhysicalMaterial({ color: 0x3cb371, roughness: 0.8 });
        const darkGreen = new THREE.MeshPhysicalMaterial({ color: 0x006400, roughness: 0.9 });
        addPart(14, 6, 16, 0, 4, 0, darkGreen); // Shell
        addPart(6, 6, 6, 0, 4, 10, green); // Head
        addPart(4, 2, 4, -8, 2, 6, green); addPart(4, 2, 4, 8, 2, 6, green); // Front flippers
        addPart(4, 2, 4, -8, 2, -6, green); addPart(4, 2, 4, 8, 2, -6, green); // Back flippers
        addPart(2, 2, 4, 0, 2, -10, green); // Small tail
    }

    state.scene.add(animalGroup);

    // Physics Body (Bounding Box representation)
    const boxShape = new CANNON.Box(new CANNON.Vec3((12 * u) / 2, (heightOffset * 2 * u) / 2, (20 * u) / 2));

    // Spawn randomly on board, drop from sky (halved height)
    const spawnX = (Math.random() - 0.5) * 1600;
    const spawnZ = (Math.random() - 0.5) * 1600;
    const spawnY = 400 + Math.random() * 200; // Halved from 800 + 400

    const body = new CANNON.Body({
        mass: 5,
        shape: boxShape,
        position: new CANNON.Vec3(spawnX, spawnY, spawnZ),
        material: new CANNON.Material(),
        fixedRotation: true // Keep upright
    });

    if (state.world) {
        state.world.addBody(body);
    }

    const speed = 150 + Math.random() * 150; // Faster roaming (150-300 units/sec)

    const animalData = {
        mesh: animalGroup,
        body: body,
        state: 'falling',
        timer: 1.0,
        targetDir: new THREE.Vector3(),
        speed: speed,
        heightOffset: heightOffset
    };

    animals.push(animalData);
}

function removeOldestAnimal() {
    const animal = animals.shift();
    if (animal) {
        if (animal.mesh) state.scene.remove(animal.mesh);
        if (animal.body && state.world) state.world.removeBody(animal.body);
    }
}

export function updateDogs(dt) {
    const boardLimit = 1000 - voxelSize;

    animals.forEach(animal => {
        // If falling, wait until resting on ground
        if (animal.state === 'falling') {
            if (animal.body && Math.abs(animal.body.velocity.y) < 1.0 && animal.body.position.y < 50) {
                animal.state = 'idle';
                animal.timer = 0.5;
            }
        } else {
            animal.timer -= dt;

            if (animal.timer <= 0) {
                if (animal.state === 'idle') {
                    animal.state = 'walking';
                    animal.timer = 2 + Math.random() * 6; // Walk 2-8 seconds
                    const angle = Math.random() * Math.PI * 2;
                    animal.targetDir.set(Math.sin(angle), 0, Math.cos(angle)).normalize();
                } else {
                    animal.state = 'idle';
                    animal.timer = 0.5 + Math.random() * 2; // Short idle 0.5-2.5 secs
                }
            }
        }

        if (animal.state === 'walking' && animal.body) {
            let hitBoundary = false;
            // Very proactive boundary checking to keep them inside the board
            const predictX = animal.body.position.x + animal.targetDir.x * animal.speed * 0.5;
            const predictZ = animal.body.position.z + animal.targetDir.z * animal.speed * 0.5;

            if (predictX > boardLimit || predictX < -boardLimit) {
                animal.targetDir.x *= -1;
                hitBoundary = true;
            }
            if (predictZ > boardLimit || predictZ < -boardLimit) {
                animal.targetDir.z *= -1;
                hitBoundary = true;
            }

            // Apply velocity
            animal.body.velocity.x = animal.targetDir.x * animal.speed;
            animal.body.velocity.z = animal.targetDir.z * animal.speed;

            // Turn smoothly or instantly
            animal.mesh.rotation.y = Math.atan2(animal.targetDir.x, animal.targetDir.z);

        } else if (animal.state === 'idle' && animal.body) {
            animal.body.velocity.x = 0;
            animal.body.velocity.z = 0;
        }

        if (animal.body) {
            animal.mesh.position.copy(animal.body.position);
            // offset body slightly so feet touch ground (body center vs mesh origin)
            animal.mesh.position.y -= (animal.heightOffset * (voxelSize / 20));
        }
    });
}
