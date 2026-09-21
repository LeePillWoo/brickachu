import * as THREE from 'three';
import { state, objects, voxelSize } from './state.js';
import { animals } from './entities.js';
import { playSound } from './sound.js';

export const TRAIN_SPEED = 110;
export const TRAIN_JOIN_RADIUS = 300;
export const MAX_TRAIN_ROUTE_POINTS = 160;
export const MAX_TRAIN_ROUTE_LENGTH = 8000;
const TRAIN_RADIUS = 68, TRAIN_HEIGHT = 110;
const BOARD_LIMIT = 900, JOIN_INTERVAL = 0.65, MAX_TRAIL_POINTS = 4096;
const ROPE_SEGMENTS = 8;
const DRIVE_BEATS = ['train-chuff', 'train-chuff', 'train-puff', 'train-puff'];
const isLivingBlock = animal => Boolean(animal?.livingId) || animal?.animalType === 'living-block';

function disposeTree(root) {
    if (!root) return;
    root.removeFromParent();
    const geometries = new Set(), materials = new Set();
    root.traverse(child => {
        if (child.geometry) geometries.add(child.geometry);
        if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach(material => materials.add(material));
        delete child.userData.trainRef;
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
}

function buildEngine() {
    const mesh = new THREE.Group();
    mesh.name = 'friend-train';
    const colors = { blue: 0x64bce7, teal: 0x5acbb4, red: 0xf77b82, gold: 0xffd66c, dark: 0x344763, white: 0xffffff };
    const materials = Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, new THREE.MeshPhysicalMaterial({ color, roughness: 0.45 })]));
    function box(w, h, d, x, y, z, color) {
        const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[color]);
        part.position.set(x, y, z); part.castShadow = true; part.receiveShadow = true; mesh.add(part); return part;
    }
    box(60, 13, 91, 0, 20, 0, 'red');
    box(50, 35, 68, 0, 42, 10, 'blue');
    box(57, 48, 35, 0, 58, -26, 'teal');
    box(65, 8, 44, 0, 85, -26, 'gold');
    box(38, 23, 2, 0, 62, -44.5, 'dark');
    for (const side of [-1, 1]) box(2, 22, 21, side * 29, 63, -26, 'white');
    box(65, 10, 12, 0, 22, 50, 'gold');
    box(14, 25, 14, 0, 72, 27, 'dark');
    box(22, 7, 22, 0, 87, 27, 'gold');
    const wheelGeometry = new THREE.CylinderGeometry(13, 13, 9, 12);
    const hubGeometry = new THREE.CylinderGeometry(5, 5, 10, 10);
    const wheels = [];
    for (const side of [-1, 1]) for (const z of [-30, 0, 30]) {
        const wheel = new THREE.Group(); wheel.position.set(side * 32, 14, z);
        const tire = new THREE.Mesh(wheelGeometry, materials.dark); tire.rotation.z = Math.PI / 2; tire.castShadow = true; wheel.add(tire);
        const hub = new THREE.Mesh(hubGeometry, materials.gold); hub.rotation.z = Math.PI / 2; wheel.add(hub);
        mesh.add(wheel); wheels.push(wheel);
    }
    const sphere = new THREE.SphereGeometry(1, 12, 8);
    for (const x of [-12, 12]) {
        const white = new THREE.Mesh(sphere, materials.white); white.position.set(x, 49, 45); white.scale.set(8, 10, 4); mesh.add(white);
        const pupil = new THREE.Mesh(sphere, materials.dark); pupil.position.set(x, 49, 48); pupil.scale.set(3.5, 5, 2.5); mesh.add(pupil);
    }
    box(11, 3, 3, 0, 35, 45, 'dark');
    const steam = [];
    for (let i = 0; i < 6; i++) {
        const puff = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: 0xfff7e3, transparent: true, opacity: 0, depthWrite: false }));
        puff.visible = false; mesh.add(puff); steam.push({ mesh: puff, life: 0 });
    }
    return { mesh, wheels, steam };
}

function obstacles() {
    return objects.filter(block => block !== state.plane).map(block => ({
        minX: block.position.x - voxelSize / 2, maxX: block.position.x + voxelSize / 2,
        minY: block.position.y - voxelSize / 2, maxY: block.position.y + voxelSize / 2,
        minZ: block.position.z - voxelSize / 2, maxZ: block.position.z + voxelSize / 2
    }));
}

// Sweep the whole footprint, not just the next center point, so fast movement
// and sparse pointer samples cannot tunnel through a one-block wall.
function clearSegment(from, to, radius, height, blocks, allowEscape = false) {
    const limit = BOARD_LIMIT - radius;
    for (const axis of ['x', 'z']) {
        if (!Number.isFinite(from[axis]) || !Number.isFinite(to[axis])) return false;
        if (Math.abs(from[axis]) > limit + 1e-6) {
            if (!allowEscape || Math.abs(to[axis]) >= Math.abs(from[axis]) - 1e-8) return false;
        } else if (Math.abs(to[axis]) > limit + 1e-6) return false;
    }
    for (const block of blocks) {
        if (block.maxY <= 0.1 || block.minY >= height) continue;
        const minX = block.minX - radius, maxX = block.maxX + radius;
        const minZ = block.minZ - radius, maxZ = block.maxZ + radius;
        if (allowEscape && from.x > minX && from.x < maxX && from.z > minZ && from.z < maxZ) {
            // A passenger can grow after joining. Move only toward a nearest
            // exit face so the enlarged footprint never penetrates more deeply.
            const depths = [from.x - minX, maxX - from.x, from.z - minZ, maxZ - from.z];
            const nextDepths = [to.x - minX, maxX - to.x, to.z - minZ, maxZ - to.z];
            const nearest = Math.min(...depths);
            if (depths.some((depth, index) => depth <= nearest + 1e-6 && nextDepths[index] < depth - 1e-8)) continue;
            return false;
        }
        let enter = 0, leave = 1;
        for (const [axis, min, max] of [['x', block.minX - radius, block.maxX + radius], ['z', block.minZ - radius, block.maxZ + radius]]) {
            const delta = to[axis] - from[axis];
            if (Math.abs(delta) < 1e-9) {
                if (from[axis] <= min || from[axis] >= max) { enter = 2; break; }
            } else {
                const a = (min - from[axis]) / delta, b = (max - from[axis]) / delta;
                enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
            }
        }
        if (enter <= leave && enter <= 1 && leave >= 0) return false;
    }
    return true;
}

function followerSize(animal) {
    const halfHeight = animal.heightOffset * (voxelSize / 20);
    let radius = 25;
    animal.body.shapes.forEach((shape, index) => {
        const offset = animal.body.shapeOffsets[index];
        const half = shape.halfExtents;
        if (half) radius = Math.max(radius, Math.hypot(Math.abs(offset.x) + half.x, Math.abs(offset.z) + half.z));
    });
    const magicScale = Math.max(1, animal.mesh.scale.x, animal.mesh.scale.z);
    return { radius: radius * magicScale + 7, height: halfHeight * 2 + (animal.magicEffect?.ingredients.includes('balloon') ? 240 : 0) };
}

function convoySize(train) {
    let radius = TRAIN_RADIUS, height = TRAIN_HEIGHT;
    for (const animal of train.followers) {
        const size = followerSize(animal); radius = Math.max(radius, size.radius); height = Math.max(height, size.height);
    }
    return { radius, height };
}

export function detachTrainFollower(animal) {
    const ride = animal?.trainRide;
    if (!ride) return;
    const index = ride.train.followers.indexOf(animal);
    if (index !== -1) ride.train.followers.splice(index, 1);
    delete animal.trainRide;
    animal.trainJoinCooldown = 2;
    animal.state = 'idle'; animal.timer = 0.8;
    if (animal.body) { animal.body.velocity.x = 0; animal.body.velocity.z = 0; }
    if (!ride.train.clearing) updateRopes(ride.train);
}

export function clearTrain() {
    const train = state.train;
    if (!train) return;
    train.clearing = true;
    for (const animal of [...train.followers]) detachTrainFollower(animal);
    disposeTree(train.pathVisual); disposeTree(train.mesh);
    train.ropeGroup?.removeFromParent();
    train.ropeGroup?.clear(); train.ropes.length = 0;
    train.ropeGeometry?.dispose(); train.ropeMaterial?.dispose();
    train.ropeGeometry = null; train.ropeMaterial = null;
    train.pathVisual = null; train.route.length = 0; train.trail.length = 0;
    train.drawing = false; train.routeBackup = null;
    state.train = null;
}

export function spawnTrain(point) {
    if (!state.scene || !point || ![point.x, point.y, point.z].every(Number.isFinite)) return null;
    const limit = BOARD_LIMIT - TRAIN_RADIUS;
    const position = new THREE.Vector3(THREE.MathUtils.clamp(point.x, -limit, limit), 0, THREE.MathUtils.clamp(point.z, -limit, limit));
    if (point.y > 5 || !clearSegment(position, position, TRAIN_RADIUS, TRAIN_HEIGHT, obstacles())) {
        state.onToyNotice?.('기차가 달릴 빈 바닥을 골라줘! 🚂'); return null;
    }
    clearTrain();
    const model = buildEngine();
    const train = {
        ...model, position, followers: [], route: [], routeIndex: 0, drawing: false,
        pathVisual: null, pathFade: 0, routeBackup: null, draftLength: 0,
        trail: [{ position: position.clone(), distance: 0 }], distance: 0,
        heading: 0, autoGoal: null, recruitTimer: 0, elapsed: 0,
        ropeGroup: new THREE.Group(), ropes: [], ropeGeometry: null, ropeMaterial: null,
        chuffDistance: 0, chuffPhase: 0, runningTime: 0, pingTimer: 5 + Math.random() * 4,
        speed: TRAIN_SPEED, blockedNotice: false
    };
    model.mesh.position.copy(position);
    model.mesh.traverse(child => { child.userData.trainRef = train; });
    train.ropeGroup.name = 'train-friend-ropes';
    state.scene.add(model.mesh, train.ropeGroup); state.train = train;
    model.mesh.updateMatrixWorld(true);
    playSound('train-whistle');
    return train;
}

function showPath(train) {
    disposeTree(train.pathVisual);
    const group = new THREE.Group(); group.name = 'train-magic-path';
    const points = train.route.map(point => point.clone().setY(5));
    // SAO's normal/depth override needs triangle meshes. Straight cylinders
    // preserve every route segment while avoiding artifacts from THREE.Line.
    if (points.length > 1) {
        const tubeGeometry = new THREE.CylinderGeometry(2.2, 2.2, 1, 8);
        const tubeMaterial = new THREE.MeshBasicMaterial({ color: 0x9d88ff, transparent: true, opacity: 0.9, depthWrite: false });
        const cylinderAxis = new THREE.Vector3(0, 1, 0);
        for (let index = 1; index < points.length; index++) {
            const start = points[index - 1], end = points[index];
            const direction = end.clone().sub(start);
            const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
            tube.name = 'train-path-segment';
            tube.position.copy(start).add(end).multiplyScalar(0.5);
            tube.scale.y = direction.length();
            tube.quaternion.setFromUnitVectors(cylinderAxis, direction.normalize());
            group.add(tube);
        }
    }
    const geometry = new THREE.SphereGeometry(3.5, 8, 6);
    const material = new THREE.MeshBasicMaterial({ color: 0xffeaa6, transparent: true, opacity: 0.95, depthWrite: false });
    for (const point of points) { const dot = new THREE.Mesh(geometry, material); dot.position.copy(point); group.add(dot); }
    state.scene.add(group); train.pathVisual = group; train.pathFade = 3.2;
}

export function beginTrainRoute(train = state.train) {
    if (!train || train !== state.train || train.drawing) return false;
    train.routeBackup = { route: train.route.map(point => point.clone()), routeIndex: train.routeIndex, autoGoal: train.autoGoal?.clone() || null };
    train.route = [train.position.clone()]; train.routeIndex = 0; train.draftLength = 0;
    train.drawing = true; train.blockedNotice = false; showPath(train);
    return true;
}

export function appendTrainRoutePoint(point) {
    const train = state.train;
    if (!train?.drawing || !point || ![point.x, point.z].every(Number.isFinite)) return false;
    if (train.route.length >= MAX_TRAIN_ROUTE_POINTS) return false;
    const size = convoySize(train), limit = BOARD_LIMIT - size.radius;
    const next = new THREE.Vector3(THREE.MathUtils.clamp(point.x, -limit, limit), 0, THREE.MathUtils.clamp(point.z, -limit, limit));
    const last = train.route.at(-1), length = next.distanceTo(last);
    if (length < 18 || train.draftLength + length > MAX_TRAIN_ROUTE_LENGTH) return false;
    if (!clearSegment(last, next, size.radius, size.height, obstacles(), true)) {
        if (!train.blockedNotice) state.onToyNotice?.('블록을 피해서 길을 이어 그려줘! ✨');
        train.blockedNotice = true; return false;
    }
    train.route.push(next); train.draftLength += length; showPath(train); return true;
}

export function finishTrainRoute() {
    const train = state.train;
    if (!train?.drawing) return false;
    if (train.route.length < 2) { cancelTrainRoute(); return false; }
    train.drawing = false; train.routeIndex = 1; train.routeBackup = null;
    train.autoGoal = null; train.pathFade = 3.2; playSound('train-route'); return true;
}

export function cancelTrainRoute() {
    const train = state.train;
    if (!train?.drawing) return false;
    const previous = train.routeBackup;
    train.route = previous?.route || []; train.routeIndex = previous?.routeIndex || 0;
    train.autoGoal = previous?.autoGoal || null; train.drawing = false; train.routeBackup = null;
    disposeTree(train.pathVisual); train.pathVisual = null;
    if (train.route.length > 1) showPath(train);
    return true;
}

function sampleTrail(train, distance) {
    const trail = train.trail;
    if (distance <= trail[0].distance) return trail[0].position.clone();
    for (let index = trail.length - 1; index > 0; index--) {
        const a = trail[index - 1], b = trail[index];
        if (distance >= a.distance) return a.position.clone().lerp(b.position, Math.min(1, (distance - a.distance) / Math.max(1e-8, b.distance - a.distance)));
    }
    return train.position.clone();
}

function recordTrail(train, position) {
    const length = train.position.distanceTo(position);
    if (length < 1e-8) return;
    train.distance += length; train.position.copy(position);
    const last = train.trail.at(-1), previous = train.trail.at(-2);
    const oldDirection = previous && last.position.clone().sub(previous.position).normalize();
    const newDirection = position.clone().sub(last.position).normalize();
    if (previous && last.distance - previous.distance < 8 && oldDirection.dot(newDirection) > 0.999999) {
        last.position.copy(position); last.distance = train.distance;
    } else train.trail.push({ position: position.clone(), distance: train.distance });
    // A bounded real trajectory lasts far longer than a full twenty-friend tail.
    while (train.trail.length > MAX_TRAIL_POINTS) train.trail.shift();
}

function recruit(train, blocks) {
    const tail = train.followers.at(-1);
    const meeting = tail?.trainRide?.lastPosition || train.position;
    const candidates = animals.filter(animal => animal.body && !isLivingBlock(animal) && !animal.grabbed && !animal.trainRide && !(animal.trainJoinCooldown > 0)
        && animal.body.position.y - animal.heightOffset * (voxelSize / 20) < 260)
        .map(animal => ({ animal, distance: Math.hypot(animal.body.position.x - meeting.x, animal.body.position.z - meeting.z) }))
        .filter(candidate => candidate.distance <= TRAIN_JOIN_RADIUS).sort((a, b) => a.distance - b.distance);
    for (const { animal } of candidates) {
        const from = new THREE.Vector3(animal.body.position.x, 0, animal.body.position.z), size = followerSize(animal);
        const convoy = convoySize(train);
        if (!clearSegment(train.position, train.position, Math.max(convoy.radius, size.radius), Math.max(convoy.height, size.height), blocks)) continue;
        // Admission is friendly immediately, including while waiting for room.
        if (!clearSegment(from, meeting, size.radius, size.height, blocks)) continue;
        const forward = new THREE.Vector3(Math.sin(train.heading), 0, Math.cos(train.heading));
        const side = new THREE.Vector3(forward.z, 0, -forward.x);
        const relative = from.clone().sub(train.position);
        const safeGap = TRAIN_RADIUS + size.radius + 20;
        let approach = null;
        if (relative.dot(forward) > 0 && Math.abs(relative.dot(side)) < safeGap) {
            for (const sign of [Math.sign(relative.dot(side)) || 1, -(Math.sign(relative.dot(side)) || 1)]) {
                const candidate = from.clone().addScaledVector(side, sign * safeGap - relative.dot(side));
                const behind = train.position.clone().addScaledVector(side, sign * safeGap).addScaledVector(forward, -safeGap);
                if (clearSegment(from, candidate, size.radius, size.height, blocks) && clearSegment(candidate, behind, size.radius, size.height, blocks)) {
                    approach = [candidate, behind]; break;
                }
            }
            if (!approach) continue;
        }
        animal.trainRide = { train, joining: true, distance: train.trail[0].distance, lastPosition: from.clone(), approach, waitTime: 0 };
        animal.isClimbing = false; animal.isEating = false; animal.clickActionTimer = 0;
        animal.mesh.rotation.x = 0; animal.mesh.rotation.z = 0;
        train.followers.push(animal); return;
    }
}

function followerSpeed(animal) {
    return Math.max(0, animal.speed) * (animal.magicEffect?.ingredients.includes('balloon') ? 0.4 : 1);
}

function updateFollowers(train, dt, blocks) {
    let spacing = TRAIN_RADIUS + 20;
    for (const animal of [...train.followers]) {
        if (!animals.includes(animal) || isLivingBlock(animal) || animal.grabbed || !animal.body) { detachTrainFollower(animal); continue; }
        const ride = animal.trainRide, size = followerSize(animal);
        spacing += size.radius;
        ride.followDistance = spacing;
        const targetDistance = train.distance - spacing;
        const canFollow = targetDistance >= train.trail[0].distance;
        const old = ride.lastPosition.clone();
        let next = old.clone(), moved = 0;
        let nextDistance = ride.distance, joining = ride.joining;
        if (!train.drawing && (canFollow || ride.approach)) {
            const budget = followerSpeed(animal) * dt;
            if (ride.approach) {
                const length = old.distanceTo(ride.approach[0]);
                next.lerp(ride.approach[0], Math.min(1, budget / Math.max(length, 1e-8)));
                if (length <= budget + 0.001) {
                    ride.approach.shift();
                    if (!ride.approach.length) ride.approach = null;
                }
            } else if (ride.joining) {
                // Join the historical tail location once, then stay on the real
                // polyline. Following its vertices avoids shortcuts at corners.
                const meetingDistance = Math.max(train.trail[0].distance, targetDistance);
                const meeting = sampleTrail(train, meetingDistance);
                const length = old.distanceTo(meeting);
                next.copy(old).lerp(meeting, Math.min(1, budget / Math.max(length, 1e-8)));
                if (length <= budget + 1) { joining = false; nextDistance = meetingDistance; next.copy(meeting); }
            } else {
                const desired = Math.max(ride.distance, Math.min(targetDistance, ride.distance + budget));
                // Each crossed segment is checked separately, including turns.
                let cursor = old;
                const points = train.trail.filter(point => point.distance > ride.distance && point.distance < desired).map(point => point.position);
                points.push(sampleTrail(train, desired));
                let safe = true;
                for (const point of points) {
                    if (!clearSegment(cursor, point, size.radius, size.height, blocks, true)) { safe = false; break; }
                    cursor = point;
                }
                if (safe) { next.copy(cursor); nextDistance = desired; }
                else joining = true;
            }
            if (ride.joining && !clearSegment(old, next, size.radius, size.height, blocks, true)) {
                next.copy(old); nextDistance = ride.distance; joining = ride.joining;
            }
            moved = old.distanceTo(next);
        }
        ride.distance = nextDistance; ride.joining = joining;
        ride.lastPosition.copy(next);
        animal.body.position.x = next.x; animal.body.position.z = next.z;
        animal.body.velocity.x = (next.x - old.x) / dt; animal.body.velocity.z = (next.z - old.z) / dt;
        animal.body.aabbNeedsUpdate = true;
        animal.state = moved > 0.001 ? 'walking' : 'idle'; animal.timer = 1;
        if (moved > 0.001) {
            animal.targetDir.copy(next).sub(old).normalize();
            animal.mesh.rotation.y = Math.atan2(animal.targetDir.x, animal.targetDir.z);
        }
        spacing += size.radius + 18;
    }
}

function chooseAutoGoal(train, size, blocks) {
    const start = train.heading + (Math.random() - 0.5) * 0.7;
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
        const angle = start + turn;
        const goal = train.position.clone().add(new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(140 + Math.random() * 130));
        if (clearSegment(train.position, goal, size.radius, size.height, blocks, true)) return goal;
    }
    return null;
}

function animalRopeAnchor(animal, front) {
    const halfHeight = animal.heightOffset * (voxelSize / 20);
    let depth = 15;
    animal.body.shapes.forEach((shape, index) => {
        if (shape.halfExtents) depth = Math.max(depth, Math.abs(animal.body.shapeOffsets[index].z) + shape.halfExtents.z);
    });
    animal.mesh.updateWorldMatrix(true, false);
    return animal.mesh.localToWorld(new THREE.Vector3(0, Math.max(12, Math.min(halfHeight * 0.9, 38)), depth * 0.7 * front));
}

function updateRopes(train) {
    if (!train.ropeGroup || train.clearing) return;
    while (train.ropes.length > train.followers.length) {
        const rope = train.ropes.pop(); rope.mesh.removeFromParent(); rope.mesh.clear();
    }
    if (train.followers.length && !train.ropeGeometry) {
        train.ropeGeometry = new THREE.CylinderGeometry(2.2, 2.2, 1, 6);
        train.ropeMaterial = new THREE.MeshStandardMaterial({ color: 0xcda473, roughness: 1 });
    }
    const cylinderAxis = new THREE.Vector3(0, 1, 0);
    for (let index = 0; index < train.followers.length; index++) {
        const animal = train.followers[index];
        let rope = train.ropes[index];
        if (!rope) {
            const mesh = new THREE.Group(); mesh.name = 'train-rope-link';
            const segments = Array.from({ length: ROPE_SEGMENTS }, () => {
                const segment = new THREE.Mesh(train.ropeGeometry, train.ropeMaterial);
                segment.name = 'train-rope-segment'; mesh.add(segment); return segment;
            });
            rope = { mesh, segments, start: new THREE.Vector3(), end: new THREE.Vector3() };
            train.ropes.push(rope); train.ropeGroup.add(mesh);
        }
        rope.from = index === 0 ? train : train.followers[index - 1]; rope.to = animal;
        if (index === 0) rope.start.copy(train.position).add(new THREE.Vector3(-Math.sin(train.heading) * 47, 30, -Math.cos(train.heading) * 47));
        else rope.start.copy(animalRopeAnchor(rope.from, -1));
        rope.end.copy(animalRopeAnchor(animal, 1));
        const sag = Math.min(18, rope.start.distanceTo(rope.end) * 0.1);
        const sample = t => {
            const p = rope.start.clone().lerp(rope.end, t);
            p.y = Math.max(3, p.y - sag * 4 * t * (1 - t)); return p;
        };
        let previous = sample(0);
        for (let part = 0; part < ROPE_SEGMENTS; part++) {
            const next = sample((part + 1) / ROPE_SEGMENTS), direction = next.clone().sub(previous);
            const segment = rope.segments[part], length = direction.length();
            segment.visible = length > 0.001;
            segment.position.copy(previous).add(next).multiplyScalar(0.5);
            segment.scale.y = Math.max(length, 0.001);
            if (length > 0.001) segment.quaternion.setFromUnitVectors(cylinderAxis, direction.normalize());
            previous = next;
        }
    }
    train.ropeGroup.updateMatrixWorld(true);
}

// Balloon drift changes heading/scale after AI. Call once after snack updates
// (or just before rendering) so ropes use the final visible attachment points.
export function syncTrainRopes() {
    if (state.train) updateRopes(state.train);
}

function emitSteam(train, count = 1, emphasized = false) {
    for (let index = 0; index < count; index++) {
        const puff = train.steam.find(particle => particle.life <= 0) || train.steam.reduce((a, b) => a.life < b.life ? a : b);
        puff.maxLife = emphasized ? 1.3 : 0.9; puff.life = puff.maxLife;
        puff.baseScale = emphasized ? 8 : 5; puff.riseSpeed = emphasized ? 39 : 26;
        puff.drift = emphasized ? (index - (count - 1) / 2) * 8 : (Math.random() - 0.5) * 8;
        puff.emphasized = emphasized;
        puff.mesh.position.set(emphasized ? (index - (count - 1) / 2) * 6 : 0, 96, 27);
        puff.mesh.visible = true;
    }
}

function updateVisuals(train, dt, traveled) {
    train.mesh.position.copy(train.position);
    train.mesh.rotation.y = train.heading;
    train.wheels.forEach(wheel => { wheel.rotation.x -= traveled / 13; });
    if (traveled > 0.001 && !train.drawing && !document.hidden) {
        train.chuffDistance += traveled; train.runningTime += dt; train.pingTimer -= dt;
        if (train.chuffDistance >= 26) {
            train.chuffDistance %= 26;
            playSound(DRIVE_BEATS[train.chuffPhase]);
            train.chuffPhase = (train.chuffPhase + 1) % DRIVE_BEATS.length; emitSteam(train);
        }
        if (train.pingTimer <= 0) {
            playSound('train-ping'); emitSteam(train, 3, true);
            train.pingTimer = 5 + Math.random() * 4;
        }
    }
    for (const puff of train.steam) {
        if (puff.life <= 0) continue;
        puff.life = Math.max(0, puff.life - dt); puff.mesh.visible = puff.life > 0;
        const age = puff.maxLife - puff.life;
        puff.mesh.position.y += dt * (puff.riseSpeed + age * 9); puff.mesh.position.z -= dt * 13;
        puff.mesh.position.x += dt * puff.drift;
        puff.mesh.scale.setScalar(puff.baseScale + age * 10); puff.mesh.material.opacity = puff.life / puff.maxLife * 0.48;
    }
    if (train.pathVisual && !train.drawing) {
        train.pathFade -= dt;
        if (train.pathFade <= 0) { disposeTree(train.pathVisual); train.pathVisual = null; }
        else train.pathVisual.traverse(child => { if (child.material) child.material.opacity = Math.min(1, train.pathFade / 2) * 0.9; });
    }
    train.mesh.updateMatrixWorld(true);
    updateRopes(train);
}

export function updateTrain(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    for (const animal of animals) if (animal.trainJoinCooldown > 0) animal.trainJoinCooldown = Math.max(0, animal.trainJoinCooldown - dt);
    const train = state.train;
    if (!train) return;
    dt = Math.min(dt, 0.1);
    const blocks = obstacles();
    for (const animal of [...train.followers]) if (!animals.includes(animal) || isLivingBlock(animal) || animal.grabbed) detachTrainFollower(animal);
    train.elapsed += dt; train.recruitTimer -= dt;
    if (!train.drawing && train.recruitTimer <= 0) { recruit(train, blocks); train.recruitTimer = JOIN_INTERVAL; }
    const size = convoySize(train);
    train.speed = Math.min(TRAIN_SPEED, ...train.followers.map(animal => followerSpeed(animal) * 0.8));
    const before = train.position.clone();
    if (!train.drawing) {
        let target = train.route[train.routeIndex];
        if (!target) {
            if (!train.autoGoal || train.position.distanceTo(train.autoGoal) < 2) train.autoGoal = chooseAutoGoal(train, size, blocks);
            target = train.autoGoal;
        }
        if (target) {
            const delta = target.clone().sub(train.position), distance = delta.length();
            const step = Math.min(distance, train.speed * dt);
            const next = train.position.clone().addScaledVector(delta, step / Math.max(distance, 1e-8));
            if (clearSegment(train.position, next, size.radius, size.height, blocks, true)) {
                if (step > 0.001) train.heading = Math.atan2(delta.x, delta.z);
                recordTrail(train, next);
                if (distance <= step + 0.01) {
                    if (train.route[train.routeIndex]) train.routeIndex++;
                    else train.autoGoal = null;
                    if (train.routeIndex >= train.route.length) { train.route = []; train.routeIndex = 0; }
                }
            } else { train.route = []; train.routeIndex = 0; train.autoGoal = null; }
        }
    }
    updateFollowers(train, dt, blocks);
    updateVisuals(train, dt, train.position.distanceTo(before));
}
