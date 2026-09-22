import * as THREE from 'three';
import { state, voxelSize, objects } from './state.js';
import { playSound } from './sound.js';
import { normalizeIngredients } from './magic.js';
import { createSoftBoxGeometry, mergeStaticParts } from './model-utils.js';

// ── 낙하 물리 상수 ──
const FOOD_GRAVITY = -980;
const FOOD_GROUND_BASE = 0;
const _foodRaycaster = new THREE.Raycaster();
const _foodRayDown = new THREE.Vector3(0, -1, 0);

function getFoodGroundY(x, fromY, z) {
    _foodRaycaster.set(new THREE.Vector3(x, fromY, z), _foodRayDown);
    const meshes = objects.filter(o => o && o.isMesh);
    if (state.plane && !meshes.includes(state.plane)) meshes.push(state.plane);
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
const removalEffects = new Set();

function disposeFood(food) {
    if (food.disposed) return;
    food.disposed = true;
    food.eaten = true;
    removalEffects.delete(food);
    state.scene.remove(food.mesh);
    const geometries = new Set();
    const materials = new Set();
    food.mesh.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) {
            for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
        }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
}

function animateFoodRemoval(food, pop = false) {
    food.eaten = true;
    removalEffects.add(food);
    const startScale = food.mesh.scale.x;
    let elapsed = 0;
    let previous = performance.now();
    function frame(now) {
        if (food.disposed) return;
        elapsed += Math.max(0, Math.min((now - previous) / 1000, 0.1));
        previous = now;
        const scale = pop && elapsed < 0.06
            ? 1 + elapsed / 0.06 * 0.35
            : Math.max(0, (pop ? 1.35 : 1) * (1 - (elapsed - (pop ? 0.06 : 0)) / 0.16));
        food.mesh.scale.setScalar(startScale * scale);
        if (scale > 0) requestAnimationFrame(frame);
        else disposeFood(food);
    }
    requestAnimationFrame(frame);
}

// ── 먹이 고스트 (Ghost Preview) ──
let _ghost = null;
let _ghostRecipe = '';

function disposeFoodMesh(mesh) {
    if (!mesh) return;
    mesh.removeFromParent();
    const geometries = new Set(), materials = new Set();
    mesh.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
}

function createFoodMesh(ingredients, ghost = false) {
    const u = voxelSize / 25;
    const group = new THREE.Group();
    group.userData.ingredients = [...ingredients];
    const balloon = ingredients.includes('balloon');
    const pudding = ingredients.includes('jelly');
    const rainbow = ingredients.includes('rainbow');
    function mat(color, extra = {}) {
        return ghost
            ? new THREE.MeshBasicMaterial({ color, opacity: 0.48, transparent: true, depthWrite: false })
            : new THREE.MeshPhysicalMaterial({ color, roughness: pudding ? 0.15 : 0.6, ...extra });
    }
    function add(geometry, x, y, z, material, ingredient) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x * u, y * u, z * u);
        mesh.castShadow = !ghost;
        if (ingredient) mesh.userData.snackIngredient = ingredient;
        group.add(mesh);
        return mesh;
    }
    function box(w, h, d, x, y, z, material, ingredient) {
        return add(createSoftBoxGeometry(w * u, h * u, d * u, Math.min(w, h, d) * u * 0.2), x, y, z, material, ingredient);
    }
    function softBox(w, h, d, x, y, z, material, ingredient, corner = 1.5) {
        return add(createSoftBoxGeometry(w * u, h * u, d * u, corner * u), x, y, z, material, ingredient);
    }
    const green = pudding ? null : mat(ingredients.length ? 0x50c96b : 0x22aa22);
    if (!ingredients.length) {
        // One soft silhouette avoids small overlapping pieces on the fruit.
        const red = mat(0xf34b50), shine = mat(0xffc0b7);
        softBox(14, 13, 12, 0, 6.5, 0, red, null, 3);
        box(3, 4, 0.7, -3.5, 7.7, 6.15, shine);
        box(1.5, 1.5, 0.7, -1.25, 9.7, 6.15, shine);
        box(2, 6, 2, 0, 14, 0, mat(0x6b3a2a));
        softBox(7, 2.5, 4, 4.2, 15.8, 0, green, null, 0.7).rotation.z = 0.18;
        box(4.5, 0.6, 0.8, 4.3, 17.05, 0, mat(0x91de75));
    } else if (pudding) {
        // Custard with a caramel cap on a little plate, matching the 🍮 icon.
        group.name = 'snack-pudding';
        const custard = mat(0xffdf86);
        const caramel = mat(0xa94f27, { roughness: 0.25 });
        const cream = mat(0xfffaf0), cherry = mat(0xf46479);
        add(new THREE.CylinderGeometry(10 * u, 10 * u, 1.5 * u, 24), 0, 0.75, 0, cream, 'jelly');
        add(new THREE.CylinderGeometry(8.6 * u, 9.4 * u, 0.8 * u, 24), 0, 1.65, 0, mat(0xffedc5), 'jelly');
        add(new THREE.CylinderGeometry(6 * u, 8 * u, 12 * u, 24), 0, 7.5, 0, custard, 'jelly');
        add(new THREE.CylinderGeometry(6 * u, 6.35 * u, 2 * u, 24), 0, 14.5, 0, caramel, 'jelly');
        box(2, 3, 1, -2.8, 12.8, 5.2, caramel, 'jelly');
        box(1.5, 2, 1, 3.4, 13.2, 4.8, caramel, 'jelly');
        softBox(6, 2, 6, 0, 16.3, -1, cream, 'jelly', 1);
        softBox(3.5, 2, 3.5, -0.5, 18, -1, cream, 'jelly', 0.6);
        softBox(2.8, 2.8, 2.8, 1.6, 19.2, -1, cherry, 'jelly', 0.5);
        box(1, 1, 0.4, 1.1, 19.8, 0.5, cream, 'jelly');
    } else if (rainbow) {
        const colors = [0xff728f, 0xffb85a, 0xffe76a, 0x7ee299, 0x79d8ff, 0xb19bff];
        const widths = [12, 13, 14, 14, 13, 12];
        colors.forEach((color, i) => softBox(widths[i], 2.5, widths[i], 0, 1.25 + i * 2.5, 0, mat(color), 'rainbow', 0.65));
        box(2.5, 2, 0.5, -3, 11.2, 6.7, mat(0xf1fbff), 'rainbow');
        box(2, 5, 2, 0, 17, 0, mat(0x80532f));
        softBox(6, 2.5, 4, 3, 19, 0, green, null, 0.7).rotation.z = 0.18;
    } else {
        const pink = mat(0xff78ac), shine = mat(0xffd7e8);
        softBox(14, 16, 12, 0, 8, 0, pink, 'balloon', 3);
        softBox(4, 5, 0.7, -3.5, 11, 6.1, shine, 'balloon', 0.8);
        box(1.5, 1.5, 0.7, -1, 13, 6.1, shine, 'balloon');
        box(2, 5, 2, 0, 17, 0, mat(0x81552e));
        softBox(6, 3, 4, 4, 17, 0, green, null, 0.7).rotation.z = 0.18;
    }
    if (balloon) {
        // A little tied balloon marks the ingredient in both single and mixed food.
        const pink = mat(0xff88bd), ivory = mat(0xfff5dc);
        box(0.8, 12, 0.8, -8, 17, 0, ivory, 'balloon');
        softBox(10, 12, 9, -8, 27, 0, pink, 'balloon', 2.5);
        softBox(2.5, 3, 0.6, -10, 29, 4.6, ivory, 'balloon', 0.5);
        box(2.5, 2, 2.5, -8, 21, 0, pink, 'balloon');
        box(3.5, 1.5, 1.5, -9.5, 20.5, 0, pink, 'balloon').rotation.z = -0.35;
    }
    if (rainbow && pudding) {
        const colors = [0xff729f, 0xffdd6c, 0x83db99, 0x83ccff, 0xb69aff];
        colors.forEach((color, i) => box(1.4, 0.6, 1.4, -3.2 + i * 1.6, 15.8, 3.8, mat(color), 'rainbow'));
    }
    // A reused material belongs to one ingredient; keep translucent previews sortable.
    if (!ghost) mergeStaticParts(group);
    return group;
}

export function initFoodGhost() {
    disposeFoodMesh(_ghost);
    const recipe = normalizeIngredients(state.snackIngredients);
    _ghostRecipe = recipe.join('+');
    _ghost = createFoodMesh(recipe, true);
    _ghost.visible = false;
    state.scene.add(_ghost);
}

export function showFoodGhost(x, y, z) {
    if (!_ghost) return;
    if (normalizeIngredients(state.snackIngredients).join('+') !== _ghostRecipe) initFoodGhost();
    _ghost.position.set(x, y, z);
    _ghost.visible = true;
}

export function hideFoodGhost() {
    if (_ghost) _ghost.visible = false;
}

export function spawnFood(worldPosition, ingredients = state.snackIngredients) {
    const recipe = normalizeIngredients(ingredients);
    const foodGroup = createFoodMesh(recipe);
    foodGroup.position.copy(worldPosition);
    state.scene.add(foodGroup);

    const foodData = {
        mesh: foodGroup,
        position: worldPosition.clone(),
        ingredients: recipe,
        eaten: false,
        consumeTimer: -1,       // -1 = 멀쩡함, >0 = 사라지는 중
        floatTime: Math.random() * Math.PI * 2,
        falling: false,         // 낙하 중 여부
        fallVelocity: 0,        // 수직 속도 (양수=위, 음수=아래)
    };

    foodGroup.children.forEach(child => { child.userData.foodRef = foodData; });

    foods.push(foodData);
    playSound('food-place');
    return foodData;
}

// ── 개별 먹이 제거: "뿅" 효과 ──
export function removeFoodWithEffect(food) {
    const idx = foods.indexOf(food);
    if (idx === -1) return;
    foods.splice(idx, 1);
    playSound('food-remove');

    animateFoodRemoval(food, true);
}

// ── 전체 먹이 제거: 연기 효과 ──
export function clearAllFoodWithEffect() {
    const toRemove = [...foods];
    foods.length = 0;
    toRemove.forEach(food => animateFoodRemoval(food));
}

export function clearAllFood() {
    while (foods.length > 0) {
        const food = foods.pop();
        disposeFood(food);
    }
    for (const food of removalEffects) disposeFood(food);
}

export function updateFoods(dt) {
    for (let i = foods.length - 1; i >= 0; i--) {
        const food = foods[i];
        food.floatTime += dt;

        if (food.eaten || food.consumeTimer >= 0) {
            // 먹힌 뒤 2초에 걸쳐 축소 + 회전하며 사라짐
            food.consumeTimer -= dt;
            const scale = Math.max(food.consumeTimer / 2.0, 0);
            food.mesh.scale.setScalar(scale);
            food.mesh.rotation.y += dt * 4;
            if (food.consumeTimer <= 0) {
                disposeFood(food);
                foods.splice(i, 1);
            }
        } else if (!food.eaten) {
            if (food.falling) {
                // ── 낙하 물리 ──
                const previousY = food.position.y;
                food.fallVelocity += FOOD_GRAVITY * dt;
                food.position.y += food.fallVelocity * dt;
                food.mesh.position.y = food.position.y;
                food.mesh.rotation.y += dt * 5;
                food.mesh.rotation.z += dt * 2.5;

                // 착지 체크
                const groundY = getFoodGroundY(
                    food.position.x,
                    Math.max(previousY, food.position.y) + 0.01,
                    food.position.z
                );
                if (food.fallVelocity <= 0 && food.position.y <= groundY) {
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
                food.mesh.position.y = food.position.y + (1 + Math.sin(food.floatTime * 2.2)) * voxelSize * 0.09;
                food.mesh.rotation.y += dt * 0.9;
            }
        }
    }
}
