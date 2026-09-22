import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { state, objects, voxelSize } from './state.js';
import { foods, triggerFoodFall } from './food.js';
import { applySnack, clearMagicEffect } from './magic.js';
import { getGroundHeightBelow } from './entities.js';
import { playSound } from './sound.js';
import { createSoftBoxGeometry, mergeStaticParts } from './model-utils.js';

const POWER_INFO = {
    otter: { name: '친구 물미끄럼틀', description: '배로 슝! 물길을 밟은 친구도 함께 미끄러져요.' },
    panda: { name: '데굴데굴 볼링', description: '둥글게 굴러가 알록달록 장난감 핀을 쓰러뜨려요.' },
    octopus: { name: '물감 도장', description: '발 도장을 찍고 가까운 블록을 잠깐 물들여요.' },
    crab: { name: '간식 배달', description: '가까이 놓인 간식을 들고 친구에게 배달해요.' },
    hedgehog: { name: '꽃송이 산책', description: '등에서 꽃이 피고 걸어간 자리에 꽃길이 생겨요.' },
    'baby-dragon': { name: '비눗방울 숨결', description: '친구를 비눗방울에 태워요. 친구를 누르면 뽁!' },
    penguin: { name: '얼음 미끄럼틀', description: '배로 미끄러지며 친구들도 탈 수 있는 물길을 만들어요.' },
    elephant: { name: '코끼리 분수', description: '긴 코에서 반짝이는 물방울을 뿌려요.' },
    squirtle: { name: '꼬마 물대포', description: '통통 튀는 파란 물방울을 뿜어요.' },
    bulbasaur: { name: '꽃씨 산책', description: '등에서 꽃이 피고 걸어간 자리에 꽃길이 생겨요.' },
    snail: { name: '알록달록 산책', description: '지나간 자리에 작은 파스텔 도장을 남겨요.' },
};
const COLORS = [0xff9ab8, 0x93cfdf, 0xc4a5e8, 0xffd284, 0xaad7a0];
const active = new Set(), decorations = [], bubbles = [];
const MAX_DECORATIONS = 96;
const foodRay = new THREE.Raycaster();
const motionMaterials = new WeakMap();

export function getAnimalPowerInfo(type) { return POWER_INFO[type] || null; }

function disposeTree(mesh) {
    mesh.removeFromParent();
    const geometries = new Set(), materials = new Set();
    mesh.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(m => materials.add(m));
    });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}

function removeDecoration(index) { disposeTree(decorations.splice(index, 1)[0].mesh); }

function decorate(owner, mesh, life, extra = {}, parent = state.scene) {
    if (decorations.length >= MAX_DECORATIONS) removeDecoration(0);
    mesh.userData.animalPowerDecoration = true;
    parent.add(mesh);
    const item = { owner, mesh, life, ...extra };
    decorations.push(item);
    return item;
}

function material(color, opacity = 1) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.8, transparent: true, opacity, depthWrite: false });
}

function ground(animal) {
    return getGroundHeightBelow(animal.body.position.x, animal.body.position.y + 1, animal.body.position.z, 0);
}

function available(animal) {
    return animal?.mesh?.parent && animal.body && !animal.grabbed && !animal.trainRide && !animal.livingId &&
        !animal.magicEffect?.ingredients.includes('balloon');
}

function onGround(animal) {
    return available(animal) && animal.body.position.y - (animal.heightOffset || 0) * (voxelSize / 20) < ground(animal) + 35;
}

function begin(animal, type, duration, controlsMotion = false) {
    const bounds = new THREE.Box3().setFromObject(animal.mesh);
    const power = {
        type, remaining: duration, elapsed: 0, trailTimer: 0, trailIndex: 0, controlsMotion,
        heading: animal.mesh.rotation.y, tilt: animal.mesh.rotation.clone(),
        centerY: Math.max(12, bounds.getCenter(new THREE.Vector3()).y - animal.mesh.position.y),
        topY: bounds.max.y - animal.mesh.position.y,
        lastPosition: new THREE.Vector3().copy(animal.body.position),
    };
    animal.animalPower = power; animal.powerCooldown = duration + 2;
    animal.isEating = false; animal.eatTimer = 0;
    if (controlsMotion) {
        animal.isClimbing = false; animal.climbMeshRotX = 0;
        if (state.world && state.groundMaterial && state.animalMaterial) {
            let slippery = motionMaterials.get(state.world);
            if (!slippery) {
                slippery = new CANNON.Material('animal-toy-motion');
                for (const other of [state.groundMaterial, state.animalMaterial, slippery]) state.world.addContactMaterial(
                    new CANNON.ContactMaterial(slippery, other, { friction: 0, restitution: 0.1 })
                );
                motionMaterials.set(state.world, slippery);
            }
            power.originalMaterial = animal.body.material;
            power.motionMaterial = slippery;
            animal.body.material = slippery;
        }
    }
    active.add(animal);
    return power;
}

function end(animal) {
    const power = animal.animalPower;
    if (!power) return;
    if (power.motionMaterial && animal.body?.material === power.motionMaterial) animal.body.material = power.originalMaterial;
    if (power.food?.carriedBy === animal) {
        delete power.food.carriedBy;
        if (!power.food.eaten && foods.includes(power.food)) triggerFoodFall(power.food, 0);
    }
    if (animal.mesh) {
        animal.mesh.rotation.x = power.tilt.x; animal.mesh.rotation.z = power.tilt.z;
        if (!animal.magicEffect && animal.baseScale) animal.mesh.scale.copy(animal.baseScale);
        if (power.controlsMotion && animal.body && !animal.grabbed) {
            animal.mesh.position.copy(animal.body.position);
            animal.mesh.position.y -= (animal.heightOffset || 0) * (voxelSize / 20);
        }
    }
    if (power.controlsMotion && animal.body && !animal.grabbed) {
        animal.body.velocity.x = 0; animal.body.velocity.z = 0;
        animal.state = 'idle'; animal.timer = 0.3;
    }
    delete animal.animalPower; active.delete(animal);
}

export function clearAnimalPower(animal) {
    if (!animal) return;
    end(animal);
    for (const friend of active) if (friend.animalPower?.source === animal) end(friend);
    for (let i = decorations.length - 1; i >= 0; i--) if (decorations[i].owner === animal) removeDecoration(i);
    for (let i = bubbles.length - 1; i >= 0; i--) {
        const bubble = bubbles[i];
        if (bubble.owner !== animal && bubble.friend !== animal) continue;
        if (bubble.friend.magicEffect === bubble.effect) clearMagicEffect(bubble.friend);
        bubbles.splice(i, 1);
    }
}

export function clearAllPowerDecorations() {
    for (const animal of [...active]) clearAnimalPower(animal);
    for (const bubble of bubbles.splice(0)) if (bubble.friend.magicEffect === bubble.effect) clearMagicEffect(bubble.friend);
    while (decorations.length) removeDecoration(decorations.length - 1);
}

function flower(color) {
    const group = new THREE.Group(), petals = material(color), center = material(0xffd86d);
    for (let i = 0; i < 5; i++) {
        const petal = new THREE.Mesh(new THREE.SphereGeometry(6, 8, 6), petals);
        petal.position.set(Math.sin(i * Math.PI * 0.4) * 7, 0, Math.cos(i * Math.PI * 0.4) * 7);
        petal.scale.set(1, 0.45, 1); group.add(petal);
    }
    const middle = new THREE.Mesh(new THREE.SphereGeometry(5, 8, 6), center);
    middle.scale.y = 0.55; middle.position.y = 2; group.add(middle);
    mergeStaticParts(group);
    return group;
}

function addTrail(animal, power) {
    const water = power.type === 'slide', flowers = power.type === 'flowers';
    const color = COLORS[power.trailIndex++ % COLORS.length];
    const mesh = flowers ? flower(color) : new THREE.Mesh(
        createSoftBoxGeometry(water ? 65 : 24, 1.5, water ? 60 : 20, water ? 14 : 6),
        material(water ? 0x8dd9ed : color, water ? 0.65 : 0.8)
    );
    mesh.name = water ? 'animal-water-slide' : flowers ? 'animal-flower-trail' : 'animal-paint-stamp';
    mesh.position.set(animal.body.position.x, ground(animal) + (flowers ? 4 : 2), animal.body.position.z);
    mesh.rotation.y = power.heading;
    decorate(animal, mesh, water ? 4 : 5, water ? { water: true, heading: power.heading } : {});
}

function paintBlock(animal, color) {
    const block = objects.filter(o => o !== state.plane && o.isMesh && o.parent)
        .filter(o => o.position.distanceTo(animal.body.position) < 150)
        .sort((a, b) => a.position.distanceToSquared(animal.body.position) - b.position.distanceToSquared(animal.body.position))[0];
    if (!block || decorations.some(d => d.block === block)) return;
    // A separate shell leaves the original block and undo snapshots untouched.
    const shell = new THREE.Mesh(block.geometry.clone(), material(color, 0.68));
    shell.name = 'animal-block-paint';
    decorate(animal, shell, 5, { block });
    syncPaint(shell, block);
}

function syncPaint(shell, block) {
    block.updateWorldMatrix(true, false);
    block.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    shell.scale.multiplyScalar(1.012);
}

function createPins(animal, power) {
    power.pins = [];
    const forward = new THREE.Vector3(Math.sin(power.heading), 0, Math.cos(power.heading));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    for (let row = 0; row < 3; row++) for (let column = 0; column <= row; column++) {
        const mesh = new THREE.Group(); mesh.name = 'panda-bowling-pin';
        mesh.rotation.y = power.heading;
        const body = new THREE.Mesh(createSoftBoxGeometry(15, 32, 15, 6), material(0xfffbef));
        body.position.y = 16; mesh.add(body);
        const neck = new THREE.Mesh(createSoftBoxGeometry(17, 6, 17, 2), material(COLORS[row]));
        neck.position.y = 25; mesh.add(neck);
        mesh.position.copy(animal.body.position).addScaledVector(forward, 145 + row * 33).addScaledVector(right, (column - row / 2) * 38);
        mesh.position.y = getGroundHeightBelow(mesh.position.x, animal.body.position.y + 1, mesh.position.z, 0);
        if (Math.abs(mesh.position.x) > 850 || Math.abs(mesh.position.z) > 850) { disposeTree(mesh); continue; }
        power.pins.push(decorate(animal, mesh, 6, { pin: true, knocked: false, heading: power.heading }));
    }
}

function nearestFriend(animal, list, maxDistance, predicate = () => true) {
    return list.filter(friend => friend !== animal && onGround(friend) && !friend.animalPower && predicate(friend))
        .filter(friend => friend.body.position.distanceTo(animal.body.position) < maxDistance)
        .sort((a, b) => a.body.position.distanceTo(animal.body.position) - b.body.position.distanceTo(animal.body.position))[0];
}

function clearReach(from, to) {
    const direction = new THREE.Vector3().copy(to).sub(from), distance = direction.length();
    if (distance < 0.001) return true;
    foodRay.set(from, direction.normalize());
    const blocks = objects.filter(object => object !== state.plane && object.isMesh);
    blocks.forEach(block => block.updateWorldMatrix(true, false));
    const hit = foodRay.intersectObjects(blocks, false)[0];
    return !hit || hit.distance >= distance;
}

function startDelivery(animal, list) {
    const food = foods.filter(item => !item.eaten && !item.disposed && !item.falling && !item.carriedBy && item.consumeTimer < 0)
        .filter(item => item.position.distanceTo(animal.body.position) < 220 && Math.abs(item.position.y - ground(animal)) < 60 &&
            clearReach(animal.body.position, item.position.clone().add(new THREE.Vector3(0, 12, 0))))
        .sort((a, b) => a.position.distanceToSquared(animal.body.position) - b.position.distanceToSquared(animal.body.position))[0];
    const friend = nearestFriend(animal, list, 650);
    if (!food || !friend) {
        state.onToyNotice?.(!food ? '꽃게 옆에 간식을 놓고 다시 눌러 주세요 🍎' : '간식을 받을 친구를 가까이 불러 주세요 🦀');
        return;
    }
    const power = begin(animal, 'delivery', 8, true);
    power.food = food; power.friend = friend; food.carriedBy = animal;
    carryFood(animal, power);
}

function carryFood(animal, power) {
    power.food.position.copy(animal.body.position);
    power.food.position.y += power.centerY + 18;
    power.food.mesh.position.copy(power.food.position);
}

function startBubble(animal, list) {
    const friend = nearestFriend(animal, list, 450, candidate => !candidate.magicEffect);
    if (!friend) {
        state.onToyNotice?.('변신 중이 아닌 친구를 가까이 불러 주세요 🫧');
        return;
    }
    const power = begin(animal, 'breath', 1.2);
    power.heading = Math.atan2(friend.body.position.x - animal.body.position.x, friend.body.position.z - animal.body.position.z);
    applySnack(friend, ['balloon']);
    const effect = friend.magicEffect;
    effect.remaining = 6; effect.powerBubble = true;
    // A bubble encloses the whole friend, including long ears and tails.
    const radius = effect.localBounds.getSize(new THREE.Vector3()).length() * 0.515;
    effect.decoration.scale.setScalar(radius);
    effect.localBounds.expandByPoint(effect.decoration.position.clone().addScalar(radius));
    effect.localBounds.expandByPoint(effect.decoration.position.clone().addScalar(-radius));
    effect.decoration.name = 'dragon-friend-bubble';
    effect.decoration.material.color.setHex(0x9de6f4);
    effect.decoration.material.opacity = 0.23;
    effect.decoration.children.forEach(child => { child.visible = false; });
    bubbles.push({ owner: animal, friend, effect });
    state.onToyNotice?.('친구가 비눗방울에 쏙! 친구를 누르면 뽁 터져요 🫧');
}

export function triggerAnimalPower(animal, list) {
    if (animal?.magicEffect?.powerBubble) {
        clearMagicEffect(animal); playSound('animal-remove');
        return true;
    }
    if (!getAnimalPowerInfo(animal?.animalType)) return false;
    if (!available(animal) || !onGround(animal) || animal.animalPower || animal.powerCooldown > 0 || animal.clickActionTimer > 0) return true;
    const type = animal.animalType;
    playSound('animal-click-' + animal.animGroup);
    if (type !== 'crab' && type !== 'baby-dragon') state.onToyNotice?.(`${animal.displayName || '친구'} · ${getAnimalPowerInfo(type).name}`);
    if (type === 'crab') startDelivery(animal, list);
    else if (type === 'baby-dragon') startBubble(animal, list);
    else if (type === 'panda') createPins(animal, begin(animal, 'bowling', 2.4, true));
    else if (type === 'otter' || type === 'penguin') begin(animal, 'slide', 3.2, true);
    else if (type === 'hedgehog' || type === 'bulbasaur') {
        const power = begin(animal, 'flowers', 5);
        for (let i = 0; i < 3; i++) {
            const bloom = flower(COLORS[i]); bloom.position.set((i - 1) * 17, power.topY + 3, 0);
            decorate(animal, bloom, 1.6, { bloom: true }, animal.mesh);
        }
    } else if (type === 'elephant' || type === 'squirtle') begin(animal, 'sprinkle', 1.8);
    else begin(animal, 'paint', 5);
    return true;
}

function move(animal, power, speed) {
    let x = Math.sin(power.heading) * speed, z = Math.cos(power.heading) * speed;
    if (Math.abs(animal.body.position.x) > 845 && Math.sign(x) === Math.sign(animal.body.position.x)) x = 0;
    if (Math.abs(animal.body.position.z) > 845 && Math.sign(z) === Math.sign(animal.body.position.z)) z = 0;
    animal.body.velocity.x = x; animal.body.velocity.z = z;
    animal.mesh.rotation.y = power.heading; animal.state = 'walking';
}

function tiltAroundCenter(animal, power, tilt) {
    animal.mesh.rotation.set(tilt, power.heading, 0);
    const offset = new THREE.Vector3(0, power.centerY, 0);
    const rotated = offset.clone().applyEuler(animal.mesh.rotation);
    animal.mesh.position.add(offset.sub(rotated));
}

function droplet(animal, power, bubble = false) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(bubble ? 9 : 6, 10, 8), material(bubble ? 0xb5e7f4 : 0x84cdec, bubble ? 0.4 : 0.8));
    mesh.name = bubble ? 'dragon-breath-bubble' : 'animal-water-droplet';
    mesh.position.copy(animal.body.position);
    mesh.position.y += power.centerY * 0.6;
    const direction = new THREE.Vector3(Math.sin(power.heading), 0, Math.cos(power.heading));
    mesh.position.addScaledVector(direction, 35);
    const index = power.trailIndex++;
    decorate(animal, mesh, bubble ? 1.1 : 1.5, {
        velocity: direction.multiplyScalar(bubble ? 130 : 160).add(new THREE.Vector3(Math.sin(index * 2.4) * 30, bubble ? 28 : 165, Math.cos(index * 2.4) * 30)),
        gravity: bubble ? 0 : -260,
    });
}

export function updateAnimalPowers(list, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const present = new Set(list);
    for (const animal of list) if (animal.powerCooldown > 0) animal.powerCooldown = Math.max(0, animal.powerCooldown - dt);
    for (const animal of [...active]) {
        const power = animal.animalPower;
        if (!present.has(animal) || !available(animal)) { clearAnimalPower(animal); continue; }
        power.remaining -= dt; power.elapsed += dt; power.trailTimer += dt;
        if (power.remaining <= 1e-8) { end(animal); continue; }
        if (power.type === 'slide') {
            move(animal, power, power.source ? 230 : 260);
            tiltAroundCenter(animal, power, -Math.sin(Math.min(power.elapsed * 3, Math.PI / 2)) * 0.9);
        } else if (power.type === 'bowling') {
            move(animal, power, 225); tiltAroundCenter(animal, power, -power.elapsed * 7);
            for (const pin of power.pins) {
                if (pin.knocked || !pin.mesh.parent || pin.mesh.position.distanceTo(animal.mesh.position) > 95) continue;
                pin.knocked = true; pin.life = Math.min(pin.life, 2.2);
                pin.velocity = new THREE.Vector3(Math.sin(power.heading) * 70, 70, Math.cos(power.heading) * 70); pin.gravity = -180;
            }
        } else if (power.type === 'delivery') {
            if (!foods.includes(power.food) || power.food.eaten || !present.has(power.friend) || !onGround(power.friend)) { end(animal); continue; }
            const dx = power.friend.body.position.x - animal.body.position.x, dz = power.friend.body.position.z - animal.body.position.z;
            power.heading = Math.atan2(dx, dz); move(animal, power, 190);
            // Travel sideways, with the snack visibly balanced above the shell.
            animal.mesh.rotation.y = power.heading + Math.PI / 2;
            carryFood(animal, power);
            if (Math.hypot(dx, dz) < 90 && Math.abs(power.friend.body.position.y - animal.body.position.y) < 110 &&
                clearReach(animal.body.position, power.friend.body.position)) {
                const food = power.food, friend = power.friend;
                delete food.carriedBy; food.eaten = true; food.consumeTimer = 2;
                food.position.copy(friend.body.position); food.mesh.position.copy(food.position);
                applySnack(friend, food.ingredients);
                const floating = friend.magicEffect?.ingredients.includes('balloon');
                friend.isEating = !floating; friend.eatTimer = floating ? 0 : 1.2;
                playSound('food-eat'); state.onToyNotice?.('꽃게의 간식 배달이 도착했어요 🦀'); end(animal);
                continue;
            }
        } else if (power.type === 'flowers' && power.elapsed < 1) {
            const squash = 1 - Math.sin(power.elapsed * Math.PI) * 0.22;
            if (!animal.magicEffect) animal.mesh.scale.set(animal.baseScale.x / squash, animal.baseScale.y * squash, animal.baseScale.z / squash);
        } else if (power.type === 'sprinkle' || power.type === 'breath') {
            animal.mesh.rotation.y = power.heading;
            if (power.trailTimer >= 0.12) { droplet(animal, power, power.type === 'breath'); power.trailTimer = 0; }
        }
        if (!power.source && ['slide', 'flowers', 'paint'].includes(power.type) && power.trailTimer >= 0.2 &&
            (power.trailIndex === 0 || power.lastPosition.distanceTo(animal.body.position) >= 20)) {
            addTrail(animal, power); power.lastPosition.copy(animal.body.position); power.trailTimer = 0;
            if (power.type === 'paint' && animal.animalType === 'octopus') paintBlock(animal, COLORS[power.trailIndex % COLORS.length]);
        }
    }
    for (let i = decorations.length - 1; i >= 0; i--) {
        const item = decorations[i];
        item.life -= dt;
        if (item.life <= 0 || !present.has(item.owner) || !item.owner.mesh?.parent || (item.block && !objects.includes(item.block))) { removeDecoration(i); continue; }
        if (item.block) syncPaint(item.mesh, item.block);
        if (item.velocity) {
            item.velocity.y += (item.gravity || 0) * dt; item.mesh.position.addScaledVector(item.velocity, dt);
            if (item.mesh.position.y < 3) { item.mesh.position.y = 3; item.velocity.set(0, 0, 0); }
        }
        if (item.knocked) item.mesh.rotation.x = Math.min(Math.PI / 2, item.mesh.rotation.x + dt * 5);
        if (item.bloom) item.mesh.scale.setScalar(Math.min(1, (1.6 - item.life) * 4));
        item.mesh.traverse(child => { if (child.material?.transparent) child.material.opacity = Math.min(child.material.opacity, Math.max(0, item.life)); });
        if (item.water) for (const friend of list) {
            if (friend === item.owner || friend.animalPower || friend.powerCooldown > 0 || !onGround(friend) || friend.clickActionTimer > 0) continue;
            const dx = friend.body.position.x - item.mesh.position.x, dz = friend.body.position.z - item.mesh.position.z;
            if (dx * dx + dz * dz > 60 * 60 || Math.abs(friend.body.position.y - (friend.heightOffset || 0) * 2.5 - item.mesh.position.y) > 35) continue;
            const power = begin(friend, 'slide', 1.25, true); power.heading = item.heading; power.source = item.owner;
        }
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
        const bubble = bubbles[i];
        if (!present.has(bubble.owner) || !present.has(bubble.friend) || bubble.friend.grabbed) {
            if (bubble.friend.magicEffect === bubble.effect) clearMagicEffect(bubble.friend);
            bubbles.splice(i, 1);
        } else if (bubble.friend.magicEffect !== bubble.effect) bubbles.splice(i, 1);
    }
}
