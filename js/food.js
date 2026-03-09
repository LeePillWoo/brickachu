import * as THREE from 'three';
import { state, voxelSize, objects } from './state.js';

// ── 낙하 물리 상수 ──
const FOOD_GRAVITY = -980;
const FOOD_GROUND_BASE = 80;
const _foodRaycaster = new THREE.Raycaster();
const _foodRayDown = new THREE.Vector3(0, -1, 0);

function getFoodGroundY(x, fromY, z) {
    _foodRaycaster.set(new THREE.Vector3(x, fromY, z), _foodRayDown);
    const meshes = objects.filter(o => o && o.isMesh);
    if (state.plane) meshes.push(state.plane);
    const hits = _foodRaycaster.intersectObjects(meshes, false);
    return hits.length > 0 ? hits[0].point.y : FOOD_GROUND_BASE;
}

// 외부에서 호출: HEAVY 블록 파괴 시 사과 낙하 트리거
export function triggerFoodFall(food, bounceVy = 160) {
    if (!food || food.eaten || food.consumeTimer > 0 || food.falling) return;
    food.falling = true;
    food.fallVelocity = bounceVy;
}

export const foods = [];

// ── 먹이 고스트 (Ghost Preview) ──
let _ghost = null;

export function initFoodGhost() {
    const u = voxelSize / 25;
    const mat = new THREE.MeshBasicMaterial({ color: 0x88ffaa, opacity: 0.45, transparent: true, depthWrite: false });
    const g = new THREE.Group();
    [[12,12,12,0,6,0],[4,4,4,0,12,0],[2,6,2,0,16,0],[7,3,3,5,14,0],[5,2,2,-4,13,0]].forEach(([w,h,d,x,y,z]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w*u, h*u, d*u), mat);
        m.position.set(x*u, y*u, z*u);
        g.add(m);
    });
    g.visible = false;
    _ghost = g;
    state.scene.add(g);
}

export function showFoodGhost(x, y, z) {
    if (!_ghost) return;
    _ghost.position.set(x, y, z);
    _ghost.visible = true;
}

export function hideFoodGhost() {
    if (_ghost) _ghost.visible = false;
}

export function spawnFood(worldPosition) {
    const u = voxelSize / 25;
    const foodGroup = new THREE.Group();

    const red   = new THREE.MeshPhysicalMaterial({ color: 0xff3030, roughness: 0.6 });
    const green = new THREE.MeshPhysicalMaterial({ color: 0x22aa22, roughness: 0.7 });
    const brown = new THREE.MeshPhysicalMaterial({ color: 0x6b3a2a, roughness: 0.9 });
    const pink  = new THREE.MeshPhysicalMaterial({ color: 0xffaaaa, roughness: 0.6 }); // 사과 하이라이트

    function addBox(w, h, d, x, y, z, mat) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w*u, h*u, d*u), mat);
        mesh.position.set(x*u, y*u, z*u);
        mesh.castShadow = true;
        foodGroup.add(mesh);
        return mesh;
    }

    // ── 사과 모델 ──
    addBox(12, 12, 12, 0,  6, 0, red);       // 몸통
    addBox(4,  4,  4,  0, 12, 0, pink);      // 윗면 하이라이트
    addBox(2,  6,  2,  0, 16, 0, brown);     // 꼭지
    addBox(7,  3,  3,  5, 14, 0, green);     // 잎 (오른쪽)
    addBox(5,  2,  2, -4, 13, 0, green);     // 잎 (왼쪽)

    foodGroup.position.copy(worldPosition);
    state.scene.add(foodGroup);

    const foodData = {
        mesh: foodGroup,
        position: worldPosition.clone(),
        eaten: false,
        consumeTimer: -1,       // -1 = 멀쩡함, >0 = 사라지는 중
        floatTime: Math.random() * Math.PI * 2,
        falling: false,         // 낙하 중 여부
        fallVelocity: 0,        // 수직 속도 (양수=위, 음수=아래)
    };

    foods.push(foodData);
    return foodData;
}

export function clearAllFood() {
    while (foods.length > 0) {
        const food = foods.pop();
        state.scene.remove(food.mesh);
    }
}

export function updateFoods(dt) {
    for (let i = foods.length - 1; i >= 0; i--) {
        const food = foods[i];
        food.floatTime += dt;

        if (food.consumeTimer > 0) {
            // 먹힌 뒤 2초에 걸쳐 축소 + 회전하며 사라짐
            food.consumeTimer -= dt;
            const scale = Math.max(food.consumeTimer / 2.0, 0);
            food.mesh.scale.setScalar(scale);
            food.mesh.rotation.y += dt * 4;
            if (food.consumeTimer <= 0) {
                state.scene.remove(food.mesh);
                foods.splice(i, 1);
            }
        } else if (!food.eaten) {
            if (food.falling) {
                // ── 낙하 물리 ──
                food.fallVelocity += FOOD_GRAVITY * dt;
                food.position.y += food.fallVelocity * dt;
                food.mesh.position.y = food.position.y;
                food.mesh.rotation.y += dt * 5;
                food.mesh.rotation.z += dt * 2.5;

                // 착지 체크
                const groundY = getFoodGroundY(
                    food.position.x,
                    food.position.y + voxelSize,
                    food.position.z
                );
                if (food.position.y <= groundY) {
                    food.position.y = groundY;
                    food.mesh.position.y = groundY;
                    food.mesh.rotation.z = 0;
                    if (food.fallVelocity < -250) {
                        // 바운스
                        food.fallVelocity = Math.abs(food.fallVelocity) * 0.28;
                    } else {
                        // 완전 착지
                        food.falling = false;
                        food.fallVelocity = 0;
                        food.floatTime = Math.random() * Math.PI * 2;
                    }
                }
            } else {
                // 공중에서 살짝 떠다니는 애니메이션
                food.mesh.position.y = food.position.y + Math.sin(food.floatTime * 2.2) * voxelSize * 0.18;
                food.mesh.rotation.y += dt * 0.9;
            }
        }
    }
}
