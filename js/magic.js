import * as THREE from 'three';
import { createSoftBoxGeometry } from './model-utils.js';
import { state, objects, voxelSize } from './state.js';
import { detachTrainFollower } from './train.js';
import { clearAnimalPower } from './animal-powers.js';

export const SNACK_INGREDIENTS = Object.freeze([
    Object.freeze({ id: 'balloon', icon: '🎈', label: '풍선', color: '#ff83b5', description: '동글동글 부풀어서 둥실 떠올라요' }),
    Object.freeze({ id: 'jelly', icon: '🍮', label: '푸딩', color: '#ffc15c', description: '말랑말랑! 바닥과 벽에서 통통 튀어요' }),
    Object.freeze({ id: 'rainbow', icon: '🌈', label: '무지개', color: '#8d87ff', description: '움직이는 곳마다 무지개 발자국이 생겨요' }),
]);

const INGREDIENT_IDS = new Set(SNACK_INGREDIENTS.map(item => item.id));
const EFFECT_DURATION = 20;
const BALLOON_SPEED_FACTOR = 0.12;
const BALLOON_MAX_SPEED = 36;
const BALLOON_MOVE_RESPONSE = 0.8;
const BALLOON_BOB_PERIOD = 3.6;
const BALLOON_BOB_AMPLITUDE = 18;
const BALLOON_RISE_SPEED = 110;
const TRAIL_LIFETIME = 5;
const MAX_TRAILS = 240;
const RAINBOW_COLORS = [0xff729f, 0xffac67, 0xffdf73, 0x83db99, 0x7dd5ff, 0xab91ff];
const activeEffects = new Set();
const trails = [];
let trailGeometry = null;

function balloonSpeedLimit(animal) {
    const speed = Number.isFinite(animal.speed) && animal.speed >= 0 ? animal.speed : 220;
    return Math.min(speed * BALLOON_SPEED_FACTOR, BALLOON_MAX_SPEED);
}

function readHorizontalVelocity(body, target) {
    return target.set(Number.isFinite(body?.velocity.x) ? body.velocity.x : 0, 0, Number.isFinite(body?.velocity.z) ? body.velocity.z : 0);
}

function updateBalloonDrift(animal, effect, dt) {
    const limit = balloonSpeedLimit(animal);
    // Airborne friends follow a soft breeze, independent of ground wandering,
    // predator flight and click-dash impulses. Keep even the fastest species slow.
    const phase = effect.elapsed * 0.55 + effect.windPhase;
    const heading = effect.windHeading + Math.sin(phase) * 0.45;
    const breezeSpeed = limit * (0.62 + Math.sin(phase * 0.7) * 0.08);
    effect.floatTargetVelocity.set(Math.sin(heading) * breezeSpeed, 0, Math.cos(heading) * breezeSpeed);
    for (const axis of ['x', 'z']) {
        const position = animal.body.position[axis];
        const inward = THREE.MathUtils.clamp((Math.abs(position) - 700) / 160, 0, 1);
        effect.floatTargetVelocity[axis] = THREE.MathUtils.lerp(effect.floatTargetVelocity[axis], -Math.sign(position) * breezeSpeed, inward);
    }
    if (effect.bounceTimer > 0) effect.floatTargetVelocity.copy(effect.wallBounce);
    effect.floatTargetVelocity.clampLength(0, limit);
    // Retain momentum and turn gradually rather than stopping on every idle tick.
    const response = effect.bounceTimer > 0 ? 6 : BALLOON_MOVE_RESPONSE;
    effect.floatVelocity.lerp(effect.floatTargetVelocity, -Math.expm1(-response * dt)).clampLength(0, limit);
    animal.body.velocity.x = effect.floatVelocity.x;
    animal.body.velocity.z = effect.floatVelocity.z;
    if (effect.floatVelocity.lengthSq() > 1) {
        const heading = Math.atan2(effect.floatVelocity.x, effect.floatVelocity.z);
        const turn = Math.atan2(Math.sin(heading - effect.floatHeading), Math.cos(heading - effect.floatHeading));
        effect.floatHeading += turn * -Math.expm1(-3 * dt);
    }
    // Let deliberate spins remain playful; ordinary walking and dashing turn
    // with the drifting velocity instead of snapping to the AI's next heading.
    const spinning = animal.clickActionTimer > 0 && ['spin', 'aerialSpin', 'waddleSpin'].includes(animal.clickActionType);
    if (spinning) effect.floatHeading = animal.mesh.rotation.y;
    else animal.mesh.rotation.y = effect.floatHeading;
}

export function normalizeIngredients(ids) {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter(id => INGREDIENT_IDS.has(id)))].slice(0, 2);
}

export function describeRecipe(ids) {
    const recipe = normalizeIngredients(ids);
    if (!recipe.length) return '사과';
    if (recipe.length === 1) return { balloon: '풍선 사과', jelly: '푸딩', rainbow: '무지개 열매' }[recipe[0]];
    return recipe.map(id => SNACK_INGREDIENTS.find(item => item.id === id).label).join(' + ') + ' 간식';
}

function localBoundsOf(mesh) {
    mesh.updateWorldMatrix(true, true);
    const inverse = mesh.matrixWorld.clone().invert();
    const bounds = new THREE.Box3();
    mesh.traverse(child => {
        if (!child.geometry) return;
        child.geometry.computeBoundingBox();
        if (!child.geometry.boundingBox) return;
        const transform = new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld);
        bounds.union(child.geometry.boundingBox.clone().applyMatrix4(transform));
    });
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
    return bounds;
}

function disposeDecoration(group) {
    if (!group) return;
    group.removeFromParent();
    const geometries = new Set(), materials = new Set();
    group.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
}

function addBalloonShell(animal, effect) {
    const size = effect.localBounds.getSize(new THREE.Vector3());
    const shell = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshPhysicalMaterial({ color: 0xffa6d0, transparent: true, opacity: 0.16, roughness: 0.14, depthWrite: false })
    );
    shell.name = 'snack-balloon-shell';
    shell.position.copy(effect.localBounds.getCenter(new THREE.Vector3()));
    shell.scale.set(Math.max(size.x, 16) * 0.56, Math.max(size.y, 16) * 0.56, Math.max(size.z, 16) * 0.56);
    shell.userData.animalRef = animal;
    shell.userData.magicDecoration = true;
    const ribbonMaterial = new THREE.MeshStandardMaterial({ color: 0xe788ad, roughness: 0.5 });
    const ribbonGeometry = createSoftBoxGeometry(0.26, 0.13, 0.1, 0.04);
    for (const side of [-1, 1]) {
        const ribbon = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
        ribbon.position.set(side * 0.12, -0.8, 0.48);
        ribbon.rotation.z = side * 0.2;
        ribbon.userData.magicDecoration = true;
        ribbon.userData.animalRef = animal;
        shell.add(ribbon);
    }
    animal.mesh.add(shell);
    effect.decoration = shell;
    effect.localBounds.expandByPoint(shell.position.clone().sub(shell.scale));
    effect.localBounds.expandByPoint(shell.position.clone().add(shell.scale));
}

function tintAnimal(animal, effect) {
    const tint = new THREE.Color(effect.ingredients.includes('jelly') ? 0xffca75 : 0xffa7d0);
    const copies = new Map();
    animal.mesh.traverse(child => {
        if (!child.material || child.userData.magicDecoration) return;
        const original = child.material;
        const clone = material => {
            if (copies.has(material)) return copies.get(material);
            const copy = material.clone();
            if (copy.color && (effect.ingredients.includes('balloon') || effect.ingredients.includes('jelly'))) copy.color.lerp(tint, 0.14);
            if ('roughness' in copy) copy.roughness = effect.ingredients.includes('jelly') ? 0.18 : 0.3;
            copies.set(material, copy);
            effect.materialCopies.add(copy);
            return copy;
        };
        effect.materials.push({ mesh: child, original });
        child.material = Array.isArray(original) ? original.map(clone) : clone(original);
    });
}

function removeTrail(index) {
    const [trail] = trails.splice(index, 1);
    trail.mesh.removeFromParent();
    trail.mesh.material.dispose();
    if (!trails.length && trailGeometry) {
        trailGeometry.dispose();
        trailGeometry = null;
    }
}

export function clearMagicEffect(animal) {
    const effect = animal?.magicEffect;
    if (!effect) return;
    activeEffects.delete(animal);
    for (let i = trails.length - 1; i >= 0; i--) if (trails[i].animal === animal) removeTrail(i);
    if (animal.body && effect.onCollide) animal.body.removeEventListener('collide', effect.onCollide);
    for (const { mesh, original } of effect.materials) mesh.material = original;
    effect.materialCopies.forEach(material => material.dispose());
    disposeDecoration(effect.decoration);
    if (animal.mesh) animal.mesh.scale.copy(effect.baseScale);
    // Physics materials, body shapes, mass and damping are never replaced: the
    // temporary ability only supplies motion, so gravity resumes naturally.
    if (effect.ingredients.includes('balloon')) {
        if (animal.mesh) {
            animal.mesh.rotation.x = effect.originalTilt.x;
            animal.mesh.rotation.z = effect.originalTilt.z;
        }
        if (animal.body && !animal.grabbed) animal.body.velocity.y = Math.min(animal.body.velocity.y, 0);
    }
    delete animal.magicEffect;
}

export function applySnack(animal, ids) {
    if (!animal?.mesh) return false;
    const ingredients = normalizeIngredients(ids);
    const wasMagic = Boolean(animal.magicEffect);
    // End the toy pose and its decorations before capturing the snack's base state.
    clearAnimalPower(animal);
    clearMagicEffect(animal);
    if (!ingredients.length) {
        if (wasMagic) state.onToyNotice?.('사과를 먹고 원래 모습으로 돌아왔어요!');
        return true;
    }
    const effect = {
        ingredients, remaining: EFFECT_DURATION, elapsed: 0,
        baseScale: (animal.baseScale || animal.mesh.scale).clone(),
        localBounds: localBoundsOf(animal.mesh),
        materials: [], materialCopies: new Set(), decoration: null,
        previousPosition: new THREE.Vector3().copy(animal.body?.position || animal.mesh.position),
        lastTrailPosition: new THREE.Vector3().copy(animal.body?.position || animal.mesh.position),
        trailTimer: 0, trailIndex: 0,
        bounceCooldown: 0, wallCooldown: 0, bounceTimer: 0,
        wallBounce: new THREE.Vector3(), landingImpact: 0, pendingWall: null,
        floatVelocity: new THREE.Vector3(), floatTargetVelocity: new THREE.Vector3(),
        floatHeading: animal.mesh.rotation.y,
        windHeading: animal.mesh.rotation.y,
        windPhase: ((animal.body?.position.x || 0) + (animal.body?.position.z || 0)) * 0.01,
        originalTilt: { x: animal.mesh.rotation.x, z: animal.mesh.rotation.z },
    };
    animal.magicEffect = effect;
    activeEffects.add(animal);
    tintAnimal(animal, effect);
    if (ingredients.includes('balloon')) {
        // Floating starts immediately, including mixed recipes and a friend
        // that was following a snack or riding the train a moment ago.
        detachTrainFollower(animal);
        animal.isEating = false;
        animal.eatTimer = 0;
        animal.isClimbing = false;
        animal.climbMeshRotX = 0;
        animal.state = 'idle';
        animal.timer = 0;
        addBalloonShell(animal, effect);
        if (animal.body && !animal.grabbed) {
            readHorizontalVelocity(animal.body, effect.floatVelocity).clampLength(0, balloonSpeedLimit(animal));
            animal.body.velocity.x = effect.floatVelocity.x;
            animal.body.velocity.z = effect.floatVelocity.z;
            // Cap an in-flight jump/dash before the next world.step as well.
            animal.body.velocity.y = THREE.MathUtils.clamp(Number.isFinite(animal.body.velocity.y) ? animal.body.velocity.y : 0, -200, BALLOON_RISE_SPEED);
        }
    }
    if (ingredients.includes('jelly') && animal.body) {
        effect.onCollide = event => {
            const contact = event.contact;
            if (!contact || animal.grabbed) return;
            const other = contact.bi === animal.body ? contact.bj : contact.bi;
            if (other?.mass !== 0) return;
            const sign = contact.bi === animal.body ? -1 : 1;
            const normal = new THREE.Vector3(contact.ni.x * sign, contact.ni.y * sign, contact.ni.z * sign);
            if (normal.y > 0.55) effect.landingImpact = Math.max(effect.landingImpact, -animal.body.velocity.y);
            else if (Math.abs(normal.y) < 0.45 && effect.wallCooldown <= 0) effect.pendingWall = normal;
        };
        animal.body.addEventListener('collide', effect.onCollide);
        if (!animal.grabbed && !ingredients.includes('balloon')) animal.body.velocity.y = Math.max(animal.body.velocity.y, 320);
    }
    state.onToyNotice?.(`${describeRecipe(ingredients)}! 20초 동안 신나는 변신 ✨`);
    return true;
}

function getBlockBounds() {
    const bounds = [];
    for (const object of objects) {
        if (!object?.isMesh || object === state.plane || !object.geometry) continue;
        object.updateWorldMatrix(true, false);
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (object.geometry.boundingBox) bounds.push(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
    }
    return bounds;
}

function getOffsets(animal, effect) {
    animal.mesh.updateWorldMatrix(true, false);
    const bounds = effect.localBounds.clone().applyMatrix4(animal.mesh.matrixWorld);
    const p = animal.body.position;
    const offsets = { minX: bounds.min.x - p.x, maxX: bounds.max.x - p.x, minY: bounds.min.y - p.y, maxY: bounds.max.y - p.y, minZ: bounds.min.z - p.z, maxZ: bounds.max.z - p.z };
    // Include every shape of a living block creature, including offset shapes.
    animal.body.updateAABB();
    const box = animal.body.aabb;
    offsets.minX = Math.min(offsets.minX, box.lowerBound.x - p.x);
    offsets.maxX = Math.max(offsets.maxX, box.upperBound.x - p.x);
    offsets.minY = Math.min(offsets.minY, box.lowerBound.y - p.y);
    offsets.maxY = Math.max(offsets.maxY, box.upperBound.y - p.y);
    offsets.minZ = Math.min(offsets.minZ, box.lowerBound.z - p.z);
    offsets.maxZ = Math.max(offsets.maxZ, box.upperBound.z - p.z);
    offsets.physicalMinY = box.lowerBound.y - p.y;
    return offsets;
}

function verticalSpace(position, previousPosition, offsets, blocks) {
    let ground = 0, ceiling = Infinity;
    const floorStart = Math.max(position.y, previousPosition.y) + offsets.physicalMinY + 3;
    const ceilingStart = Math.min(position.y, previousPosition.y) + offsets.physicalMinY + 3;
    for (const box of blocks) {
        if (box.max.x <= position.x + offsets.minX + 1 || box.min.x >= position.x + offsets.maxX - 1 ||
            box.max.z <= position.z + offsets.minZ + 1 || box.min.z >= position.z + offsets.maxZ - 1) continue;
        if (box.max.y <= floorStart) ground = Math.max(ground, box.max.y);
        else if (box.min.y >= ceilingStart) ceiling = Math.min(ceiling, box.min.y);
    }
    return { ground, ceiling };
}

function clampToBoard(animal, offsets) {
    const body = animal.body;
    for (const [axis, lower, upper] of [['x', offsets.minX, offsets.maxX], ['z', offsets.minZ, offsets.maxZ]]) {
        const min = Math.max(-900, -1000 - lower + 3);
        const max = Math.min(900, 1000 - upper - 3);
        const old = body.position[axis];
        body.position[axis] = min <= max ? THREE.MathUtils.clamp(old, min, max) : 0;
        if (old !== body.position[axis]) {
            const edge = old > body.position[axis] ? 1 : -1;
            if (body.velocity[axis] * edge > 0) body.velocity[axis] *= -0.7;
            if (animal.targetDir?.[axis] * edge > 0) animal.targetDir[axis] *= -1;
        }
    }
}

function updateJelly(animal, effect, dt, ground, offsets) {
    const body = animal.body;
    effect.bounceCooldown = Math.max(0, effect.bounceCooldown - dt);
    effect.wallCooldown = Math.max(0, effect.wallCooldown - dt);
    const landed = body.position.y + offsets.minY <= ground + 4 && body.velocity.y <= 30;
    if (effect.bounceCooldown <= 0 && (effect.landingImpact > 70 || landed)) {
        body.velocity.y = effect.ingredients.includes('balloon') ? 180 : Math.min(470, Math.max(300, effect.landingImpact * 0.58));
        effect.bounceCooldown = 0.45;
    }
    effect.landingImpact = 0;
    if (effect.pendingWall && effect.wallCooldown <= 0) {
        const normal = effect.pendingWall;
        const incoming = new THREE.Vector3(body.velocity.x, 0, body.velocity.z);
        if (incoming.lengthSq() < 1 && animal.targetDir) incoming.copy(animal.targetDir).multiplyScalar(animal.speed || 220);
        const dot = incoming.dot(normal);
        incoming.addScaledVector(normal, -2 * Math.min(0, dot));
        if (incoming.dot(normal) < 180) incoming.addScaledVector(normal, 180 - incoming.dot(normal));
        incoming.clampLength(180, 600);
        effect.wallBounce.copy(incoming);
        effect.bounceTimer = 0.3;
        effect.wallCooldown = 0.35;
        if (animal.targetDir) animal.targetDir.copy(incoming).setY(0).normalize();
        animal.state = 'walking';
        animal.timer = Math.max(animal.timer || 0, 0.6);
    }
    effect.pendingWall = null;
    if (effect.bounceTimer > 0) {
        effect.bounceTimer -= dt;
        body.velocity.x = effect.wallBounce.x;
        body.velocity.z = effect.wallBounce.z;
    }
}

function addTrail(animal, effect, position, footY) {
    if (!state.scene) return;
    if (trails.length >= MAX_TRAILS) removeTrail(0);
    const owned = trails.filter(trail => trail.animal === animal);
    if (owned.length >= 40) removeTrail(trails.indexOf(owned[0]));
    trailGeometry ??= createSoftBoxGeometry(13, 18, 4, 3).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: RAINBOW_COLORS[effect.trailIndex++ % RAINBOW_COLORS.length], transparent: true, opacity: 0.82, depthWrite: false });
    const mesh = new THREE.Mesh(trailGeometry, material);
    mesh.name = 'snack-rainbow-footprint';
    mesh.userData.magicTrail = true;
    mesh.position.set(position.x, footY + 2, position.z);
    mesh.rotation.y = animal.mesh.rotation.y;
    // Stagger little feet left/right; trails are decorations, never build blocks.
    const side = effect.trailIndex % 2 ? -7 : 7;
    mesh.position.x += Math.cos(mesh.rotation.y) * side;
    mesh.position.z -= Math.sin(mesh.rotation.y) * side;
    state.scene.add(mesh);
    trails.push({ animal, mesh, life: TRAIL_LIFETIME });
}

export function updateMagicEffects(animals, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const present = new Set(animals || []);
    for (const animal of activeEffects) if (!present.has(animal) || !animal.mesh?.parent) clearMagicEffect(animal);
    for (let i = trails.length - 1; i >= 0; i--) {
        trails[i].life -= dt;
        if (trails[i].life <= 0) removeTrail(i);
        else trails[i].mesh.material.opacity = Math.min(1, trails[i].life) * 0.82;
    }
    if (!activeEffects.size) return;
    const blocks = getBlockBounds();
    for (const animal of activeEffects) {
        const effect = animal.magicEffect;
        effect.remaining -= dt;
        effect.elapsed += dt;
        if (effect.remaining <= 1e-8) { clearMagicEffect(animal); continue; }
        const balloon = effect.ingredients.includes('balloon');
        const jelly = effect.ingredients.includes('jelly');
        const floatPhase = effect.elapsed * Math.PI * 2 / BALLOON_BOB_PERIOD;
        const puff = balloon ? 1.3 + Math.sin(floatPhase) * 0.025 : 1;
        const squash = jelly ? 1 + Math.sin(effect.elapsed * (balloon ? 8 : 11)) * 0.18 : 1;
        animal.mesh.scale.set(effect.baseScale.x * puff * squash, effect.baseScale.y * (balloon ? 1.16 : 1) / (squash * squash), effect.baseScale.z * puff * squash);
        if (!animal.body || animal.grabbed) {
            effect.previousPosition.copy(animal.body?.position || animal.mesh.position);
            effect.lastTrailPosition.copy(effect.previousPosition);
            effect.floatVelocity.set(0, 0, 0);
            continue;
        }
        const body = animal.body;
        if (balloon) {
            // Remove eating/hopping animation offsets before querying the
            // ceiling or deriving buoyancy; they must not shake the hover height.
            animal.mesh.position.copy(body.position);
            animal.mesh.position.y -= (animal.heightOffset || 0) * (voxelSize / 20);
            animal.mesh.rotation.x = Math.sin(floatPhase * 0.5) * 0.025;
            animal.mesh.rotation.z = Math.sin(floatPhase + 0.6) * 0.035;
        }
        let offsets = getOffsets(animal, effect);
        let { ground, ceiling } = verticalSpace(body.position, effect.previousPosition, offsets, blocks);
        if (jelly) updateJelly(animal, effect, dt, ground, offsets);
        if (balloon) {
            updateBalloonDrift(animal, effect, dt);
            if (animal.livingId) {
                animal.body.quaternion.setFromEuler(0, animal.mesh.rotation.y, 0);
                animal.body.aabbNeedsUpdate = true;
            }
            // Turning changes the footprint of a wide compound creature.
            offsets = getOffsets(animal, effect);
            ({ ground, ceiling } = verticalSpace(body.position, effect.previousPosition, offsets, blocks));
        }
        if (Number.isFinite(ceiling) && ceiling - ground > 0) {
            const visualHeight = effect.localBounds.getSize(new THREE.Vector3()).y * animal.mesh.scale.y;
            const room = ceiling - ground - 5;
            if (visualHeight > room && room > 0) {
                animal.mesh.scale.y *= room / visualHeight;
                offsets = getOffsets(animal, effect);
            }
        }
        if (balloon) {
            // Stable unanimated foot anchor keeps jelly squash and animal jumps
            // from turning a gentle bob into repeated vertical kicks.
            const footAnchor = Math.min(offsets.physicalMinY, effect.localBounds.min.y * effect.baseScale.y * 1.16 - (animal.heightOffset || 0) * (voxelSize / 20));
            const targetFoot = ground + 160 + Math.sin(floatPhase) * (jelly ? 24 : BALLOON_BOB_AMPLITUDE);
            const minY = ground - offsets.minY + 1;
            const maxY = ceiling - offsets.maxY - 3;
            const targetY = Math.max(minY, Math.min(targetFoot - footAnchor, maxY));
            const gravity = state.world?.gravity?.y ?? -1470;
            body.velocity.y = THREE.MathUtils.clamp((targetY - body.position.y) * 3, -140, BALLOON_RISE_SPEED) - gravity * dt;
            if (body.position.y + offsets.maxY > ceiling - 2 && maxY >= minY) {
                body.position.y = maxY;
                body.velocity.y = Math.min(0, body.velocity.y);
            }
            if (body.position.y < minY && maxY >= minY) body.position.y = minY;
            animal.isClimbing = false;
            if (animal.state === 'falling') { animal.state = 'idle'; animal.timer = 0.5; }
        }
        clampToBoard(animal, offsets);
        if (balloon) readHorizontalVelocity(body, effect.floatVelocity);
        body.aabbNeedsUpdate = true;
        // AI has already synchronized its mesh; only account for safety corrections.
        if (balloon) {
            animal.mesh.position.copy(body.position);
            animal.mesh.position.y -= (animal.heightOffset || 0) * (voxelSize / 20);
        } else {
            animal.mesh.position.x = body.position.x;
            animal.mesh.position.z = body.position.z;
        }
        effect.trailTimer += dt;
        const dx = body.position.x - effect.lastTrailPosition.x;
        const dz = body.position.z - effect.lastTrailPosition.z;
        if (effect.ingredients.includes('rainbow') && effect.trailTimer >= 0.12 && dx * dx + dz * dz > 12 * 12) {
            addTrail(animal, effect, body.position, Math.max(ground, body.position.y + offsets.minY));
            effect.lastTrailPosition.copy(body.position);
            effect.trailTimer = 0;
        }
        effect.previousPosition.copy(body.position);
    }
}
