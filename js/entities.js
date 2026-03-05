import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, voxelSize } from './state.js';

export const dogs = [];
const MAX_DOGS = 5;

export function spawnDog() {
    if (dogs.length >= MAX_DOGS) {
        removeOldestDog();
    }

    const dogGroup = new THREE.Group();
    const u = voxelSize / 10; // 1/10th scale unit

    // Colors
    const colors = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00, 0xffa500];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const material = new THREE.MeshPhysicalMaterial({ color: color, roughness: 0.8 });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.9 });

    // Helper to create small boxes
    function addPart(w, h, d, x, y, z, mat = material) {
        const geo = new THREE.BoxGeometry(w * u, h * u, d * u);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x * u, y * u, z * u);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        dogGroup.add(mesh);
        return mesh;
    }

    // Modeling the dog
    addPart(10, 8, 16, 0, 8, 0); // Body
    addPart(8, 8, 8, 0, 16, 12); // Head
    addPart(4, 3, 4, 0, 14, 18, blackMat); // Snout/Nose
    addPart(2, 4, 2, -3, 22, 12); // Left Ear
    addPart(2, 4, 2, 3, 22, 12); // Right Ear

    // Tail
    const tail = addPart(2, 6, 2, 0, 14, -8);
    tail.rotation.x = -Math.PI / 4;

    // Legs
    addPart(3, 6, 3, -3, 3, 5); // Front Left
    addPart(3, 6, 3, 3, 3, 5);  // Front Right
    addPart(3, 6, 3, -3, 3, -5); // Back Left
    addPart(3, 6, 3, 3, 3, -5);  // Back Right

    state.scene.add(dogGroup);

    // Physics Body (Bounding Box representation)
    const halfExtents = new CANNON.Vec3((10 * u) / 2, (18 * u) / 2, (20 * u) / 2);
    const boxShape = new CANNON.Box(halfExtents);
    const body = new CANNON.Body({
        mass: 5,
        shape: boxShape,
        position: new CANNON.Vec3(0, 30 * u, 0),
        material: new CANNON.Material(),
        fixedRotation: true // Keep upright
    });

    // Slight random initial position jump
    body.position.x = (Math.random() - 0.5) * 50;
    body.position.z = (Math.random() - 0.5) * 50;

    if (state.world) {
        state.world.addBody(body);
    }

    const dogData = {
        mesh: dogGroup,
        body: body,
        state: 'idle',
        timer: 1.0,
        targetDir: new THREE.Vector3(),
        speed: 80 // units per second
    };

    dogs.push(dogData);
}

function removeOldestDog() {
    const dog = dogs.shift();
    if (dog) {
        if (dog.mesh) state.scene.remove(dog.mesh);
        if (dog.body && state.world) state.world.removeBody(dog.body);
    }
}

export function updateDogs(dt) {
    const boardLimit = 1000 - voxelSize;

    dogs.forEach(dog => {
        dog.timer -= dt;

        if (dog.timer <= 0) {
            if (dog.state === 'idle') {
                dog.state = 'walking';
                dog.timer = 2 + Math.random() * 3;
                const angle = Math.random() * Math.PI * 2;
                dog.targetDir.set(Math.sin(angle), 0, Math.cos(angle)).normalize();

            } else {
                dog.state = 'idle';
                dog.timer = 1 + Math.random() * 3;
            }
        }

        if (dog.state === 'walking' && dog.body) {
            let hitBoundary = false;
            if (dog.body.position.x > boardLimit || dog.body.position.x < -boardLimit) {
                dog.targetDir.x *= -1;
                hitBoundary = true;
            }
            if (dog.body.position.z > boardLimit || dog.body.position.z < -boardLimit) {
                dog.targetDir.z *= -1;
                hitBoundary = true;
            }

            // Apply velocity
            dog.body.velocity.x = dog.targetDir.x * dog.speed;
            dog.body.velocity.z = dog.targetDir.z * dog.speed;

            // mesh rotation (yaw)
            dog.mesh.rotation.y = Math.atan2(dog.targetDir.x, dog.targetDir.z);

        } else if (dog.state === 'idle' && dog.body) {
            dog.body.velocity.x = 0;
            dog.body.velocity.z = 0;
        }

        if (dog.body) {
            // sync mesh to physics body (position only because rotation is handled manually for yaw)
            dog.mesh.position.copy(dog.body.position);
            // offset body slightly so feet touch ground (body center vs mesh origin)
            dog.mesh.position.y -= (10 * (voxelSize / 10)); // offset by half height roughly
        }
    });
}
