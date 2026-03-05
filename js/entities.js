import * as THREE from 'three';
import { state, voxelSize } from './state.js';

export const dogs = [];

export function spawnDog() {
    const dogGroup = new THREE.Group();

    // Pick color: red, blue, green, yellow, orange
    const colors = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00, 0xffa500];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const material = new THREE.MeshPhysicalMaterial({ color: color, roughness: 0.8 });

    // Body (2x1x3 voxels)
    const bodyGeo = new THREE.BoxGeometry(voxelSize * 2, voxelSize, voxelSize * 3);
    const body = new THREE.Mesh(bodyGeo, material);
    body.position.set(0, voxelSize / 2, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    dogGroup.add(body);

    // Head (1x1x1)
    const headGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
    const head = new THREE.Mesh(headGeo, material);
    head.position.set(0, voxelSize * 1.5, voxelSize * 1.5); // towards +z
    head.castShadow = true;
    head.receiveShadow = true;
    dogGroup.add(head);

    // Initial position at center
    dogGroup.position.set(0, 0, 0);
    state.scene.add(dogGroup);

    const dogData = {
        mesh: dogGroup,
        state: 'idle',
        timer: 1.0,
        targetDir: new THREE.Vector3(),
        speed: 100 // units per second
    };

    dogs.push(dogData);
}

export function updateDogs(dt) {
    const boardLimit = 1000 - voxelSize * 2; // Board size is 2000

    dogs.forEach(dog => {
        dog.timer -= dt;

        if (dog.timer <= 0) {
            if (dog.state === 'idle') {
                dog.state = 'walking';
                dog.timer = 2 + Math.random() * 3; // walk 2-5 secs
                const angle = Math.random() * Math.PI * 2;
                dog.targetDir.set(Math.sin(angle), 0, Math.cos(angle)).normalize();

                // Point dog in direction (head is on +z)
                dog.mesh.rotation.y = Math.atan2(dog.targetDir.x, dog.targetDir.z);
            } else {
                dog.state = 'idle';
                dog.timer = 1 + Math.random() * 3; // idle 1-4 secs
            }
        }

        if (dog.state === 'walking') {
            const nextPos = dog.mesh.position.clone().addScaledVector(dog.targetDir, dog.speed * dt);

            // Boundary check
            let hitBoundary = false;
            if (nextPos.x > boardLimit || nextPos.x < -boardLimit) {
                dog.targetDir.x *= -1;
                hitBoundary = true;
            }
            if (nextPos.z > boardLimit || nextPos.z < -boardLimit) {
                dog.targetDir.z *= -1;
                hitBoundary = true;
            }

            if (hitBoundary) {
                dog.mesh.rotation.y = Math.atan2(dog.targetDir.x, dog.targetDir.z);
            } else {
                dog.mesh.position.copy(nextPos);
            }
        }
    });
}
