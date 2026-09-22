const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
process.chdir(root);
fs.mkdirSync('.tmp/qa', { recursive: true });
const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, body) => {
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
        res.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(error ? 'Not found' : body);
    });
});
const checks = [], dependencyCache = new Map();
function check(name, condition, details) {
    assert.ok(condition, `${name}: ${JSON.stringify(details)}`);
    checks.push(name); console.log('PASS', name, details ?? '');
}
async function initialize(page, url) {
    page.setDefaultTimeout(45000);
    await page.route('**/www.googletagmanager.com/**', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    await page.route('https://unpkg.com/**', async route => {
        const source = route.request().url();
        if (!dependencyCache.has(source)) dependencyCache.set(source, fetch(source).then(async response => {
            if (!response.ok) throw new Error(`Dependency ${response.status}: ${source}`);
            return Buffer.from(await response.arrayBuffer());
        }));
        await route.fulfill({ body: await dependencyCache.get(source), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.goto(url);
    await page.waitForFunction(async () => Boolean((await import(new URL('js/state.js', document.baseURI).href)).state.previewRenderer));
    await page.evaluate(async () => {
        const load = file => import(new URL('js/' + file, document.baseURI).href);
        window.qa = { ...await load('state.js'), ...await load('scene.js'), ...await load('entities.js'), ...await load('living.js'), ...await load('food.js'), ...await load('magic.js'), ...await load('train.js'), THREE: await import('three') };
    });
}
async function resetFixture(page) {
    await page.evaluate(() => {
        qa.clearTrain(); qa.clearAllAnimals(); qa.clearAllFood();
        qa.objects.filter(block => block !== qa.state.plane).forEach(qa.removeVoxel);
        qa.state.gameSpeed = 1;
        qa.trainSteamSeen = { ordinary: false, ping: false };
        const distance = Math.max(1, 0.78 / qa.state.camera.aspect);
        qa.state.camera.position.set(560 * distance, 720 * distance, 950 * distance);
        qa.state.controls.target.set(0, 0, 0); qa.state.velocity.set(0, 0, 0);
        qa.state.controls.update(); qa.state.camera.updateMatrixWorld(true);
    });
}
async function project(page, position) {
    return page.evaluate(position => {
        const p = new qa.THREE.Vector3(...position).project(qa.state.camera);
        return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
    }, position);
}
async function trainPoint(page) {
    return page.evaluate(() => {
        const mesh = qa.state.train?.mesh;
        if (!mesh) throw new Error('No train to pick');
        qa.state.scene.updateMatrixWorld(true); qa.state.camera.updateMatrixWorld(true);
        const candidates = [];
        mesh.traverse(child => {
            if (!child.isMesh || !child.visible) return;
            const point = new qa.THREE.Box3().setFromObject(child).getCenter(new qa.THREE.Vector3()).project(qa.state.camera);
            const x = (point.x + 1) * innerWidth / 2, y = (1 - point.y) * innerHeight / 2;
            const hit = document.elementFromPoint(x, y);
            if (point.z < 1 && hit === qa.state.renderer.domElement) candidates.push({ x, y, distance: Math.hypot(point.x, point.y) });
        });
        candidates.sort((a, b) => a.distance - b.distance);
        if (!candidates.length) throw new Error('Train is not visible in the playable canvas');
        return candidates[0];
    });
}
async function cameraState(page) {
    return page.evaluate(() => ({ position: qa.state.camera.position.toArray(), quaternion: qa.state.camera.quaternion.toArray(), target: qa.state.controls.target.toArray() }));
}
function assertCamera(before, after) {
    for (const key of Object.keys(before)) for (let i = 0; i < before[key].length; i++) assert.ok(Math.abs(before[key][i] - after[key][i]) < 1e-6, `Camera ${key}[${i}] moved while drawing`);
}
async function placeTrain(page, position, touch = false) {
    await page.locator('#btn-train')[touch ? 'tap' : 'click']();
    // The button now summons immediately. Reset that engine so this fixture
    // can also exercise the optional floor-click placement at a precise point.
    await page.evaluate(() => qa.clearTrain());
    const point = await project(page, position);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => Boolean(qa.state.train?.mesh.parent));
}
async function checkAnimalCap(page, touch = false) {
    await page.evaluate(() => {
        if (qa.MAX_ANIMALS !== 30) throw new Error('Animal capacity must be thirty');
        qa.capPreviousSpeed = qa.state.gameSpeed; qa.state.gameSpeed = 0;
        qa.clearAllAnimals();
        qa.GROUP_ANIMALS.capFixture = ['dog'];
        const position = qa.state.train.position;
        const friend = (x,z) => {
            const animal = qa.spawnDog('capFixture');
            animal.body.position.set(x,animal.heightOffset * qa.voxelSize / 20,z); animal.mesh.position.set(x,0,z);
            animal.body.velocity.set(0,0,0); animal.state = 'idle'; animal.timer = 100; animal.speed = 0;
            return animal;
        };
        friend(position.x,position.z - 80);
        for (let i = 0; i < 7; i++) qa.updateTrain(0.1);
        friend(550,-650); // Older than the second passenger, but not riding.
        friend(position.x,position.z - 180);
        for (let i = 0; i < 7; i++) qa.updateTrain(0.1);
        if (qa.state.train.followers.length !== 2) throw new Error('Two passengers must join through updateTrain');
        while (qa.animals.length < qa.MAX_ANIMALS) friend(550,-650);
        delete qa.GROUP_ANIMALS.capFixture;
        qa.beginTrainRoute(); qa.appendTrainRoutePoint(position.clone().add(new qa.THREE.Vector3(0,0,400))); qa.finishTrainRoute();
        qa.captureCappedTrain = () => {
            qa.cappedTrain = qa.state.train; qa.cappedFollowers = [...qa.state.train.followers]; qa.cappedRopes = [...qa.state.train.ropes];
            qa.cappedRoute = JSON.stringify(qa.state.train.route.map(point => point.toArray()));
        };
        qa.cappedTrainIntact = () => qa.state.train === qa.cappedTrain && qa.state.train.followers.length === qa.cappedFollowers.length && qa.state.train.followers.every((animal,index) => animal === qa.cappedFollowers[index] && animal.trainRide?.train === qa.cappedTrain) && qa.state.train.ropes.length === qa.cappedRopes.length && qa.state.train.ropes.every((rope,index) => rope === qa.cappedRopes[index]) && JSON.stringify(qa.state.train.route.map(point => point.toArray())) === qa.cappedRoute;
        qa.captureCappedTrain();
    });
    for (let i = 0; i < 2; i++) {
        await page.evaluate(() => { qa.cappedFriends = [...qa.animals]; qa.capVictim = qa.animals.find(animal => !animal.trainRide); });
        await page.locator('#add-dog-btn')[touch ? 'tap' : 'click']();
        assert.ok(await page.evaluate(() => {
            const survivors = qa.cappedFriends.filter(animal => animal !== qa.capVictim);
            return qa.animals.length === qa.MAX_ANIMALS && !qa.capVictim.mesh.parent && survivors.every((animal,index) => qa.animals[index] === animal) && !qa.cappedFriends.includes(qa.animals.at(-1)) && qa.cappedTrainIntact();
        }), 'Only the oldest non-passenger may be replaced');
    }
    check(`${touch ? 'Mobile' : 'Desktop'} summons at thirty replace the oldest non-passenger while preserving joining friends, ropes and route`, true);
    await page.evaluate(() => {
        const position = qa.state.train.position;
        qa.animals.forEach((animal,index) => {
            animal.speed = 0;
            if (animal.trainRide) return;
            const x = position.x + (index % 6 - 2.5) * 36, z = position.z - 80 - Math.floor(index / 6) * 36;
            animal.body.position.set(x,animal.heightOffset * qa.voxelSize / 20,z); animal.mesh.position.set(x,0,z);
            animal.body.velocity.set(0,0,0); animal.state = 'idle'; animal.timer = 100;
        });
        for (let i = 0; i < qa.MAX_ANIMALS * 7; i++) qa.updateTrain(0.1);
        if (qa.state.train.followers.length !== qa.MAX_ANIMALS || !qa.animals.every(animal => animal.trainRide?.joining)) throw new Error('All thirty friends must genuinely join the train');
        qa.cappedFriends = [...qa.animals]; qa.captureCappedTrain();
    });
    for (let i = 0; i < 2; i++) await page.locator('#add-dog-btn')[touch ? 'tap' : 'click']();
    check(`${touch ? 'Mobile' : 'Desktop'} a full train of thirty passengers rejects summons with a notice and preserves every friend and rope`, await page.evaluate(() => qa.animals.length === qa.MAX_ANIMALS && qa.animals.every((animal,index) => animal === qa.cappedFriends[index]) && qa.cappedTrainIntact() && /30.*기차|기차.*30/.test(document.getElementById('toy-notice').textContent)));
    await page.evaluate(() => { qa.clearAllAnimals(); qa.state.gameSpeed = qa.capPreviousSpeed; });
}
async function createPassengerFixture(page, touch = false) {
    await page.evaluate(() => {
        qa.far = qa.spawnDog('carnivore');
        qa.far.mesh.position.set(-650, 0, -650); qa.far.body.position.set(-650, qa.far.heightOffset * (qa.voxelSize / 20), -650);
        qa.placeVoxel(new qa.THREE.Vector3(-75, 25, -75), 'preset-10', true);
        qa.placeVoxel(new qa.THREE.Vector3(-75, 75, -75), 'preset-9', true); qa.pushHistory();
    });
    await page.locator('#btn-eyes')[touch ? 'tap' : 'click']();
    const head = await project(page, [-75, 75, -49]);
    if (touch) await page.touchscreen.tap(head.x, head.y);
    else await page.mouse.click(head.x, head.y);
    check(`${touch ? 'Mobile tap' : 'A real eyes click'} creates a block friend for the train exclusion check`, await page.evaluate(() => qa.animals.some(animal => animal.livingId) && qa.objects.length === 1));
    await page.evaluate(() => {
        qa.blockFriend = qa.animals.find(animal => animal.livingId); qa.near = qa.spawnDog('hop');
        for (const [animal, x] of [[qa.blockFriend, -60], [qa.near, -130], [qa.far, -250]]) {
            animal.mesh.position.set(x, 0, -80); animal.body.position.set(x, animal.heightOffset * (qa.voxelSize / 20), -80);
            animal.body.velocity.set(0, 0, 0); animal.state = 'idle'; animal.timer = 100; animal.isCarnivore = false;
        }
        // Keep everyone still until placement, then restore the predator flag.
    });
}
async function checkRopeChain(page, label) {
    check(`${label} ropes connect the locomotive and each ordinary animal in order`, await page.evaluate(() => {
        const train = qa.state.train;
        return train.ropeGroup.parent === qa.state.scene && train.ropes.length === 2 && train.ropes.every((rope, i) => rope.from === (i ? train.followers[i - 1] : train) && rope.to === train.followers[i] && rope.mesh.parent === train.ropeGroup && rope.segments.length === 8 && rope.segments.every(segment => segment.visible && segment.parent && segment.geometry && segment.material));
    }));
}
async function captureTravel(page) {
    return page.evaluate(() => ({ train: qa.state.train.position.toArray(), friend: qa.near.mesh.position.toArray(), ropes: qa.state.train.ropes.map(rope => ({ start: rope.start.toArray(), end: rope.end.toArray() })) }));
}
async function checkRopeMovement(page, before, label) {
    check(`${label} rope endpoints follow the moving locomotive and animals`, await page.evaluate(before => qa.state.train.ropes.length === before.ropes.length && qa.state.train.ropes.every((rope, i) => rope.start.distanceTo(new qa.THREE.Vector3(...before.ropes[i].start)) > 10 && rope.end.distanceTo(new qa.THREE.Vector3(...before.ropes[i].end)) > 10), before));
}
async function touchEvent(session, type, points) {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id, radiusX: 1, radiusY: 1, force: 1 })) });
}
async function startDrawing(page, touchSession, routeTarget) {
    const speed = await page.evaluate(routeTarget => {
        // Keep the projected target still across browser round trips until the real press.
        const speed = qa.state.gameSpeed; qa.state.gameSpeed = 0;
        const target = qa.state.train.position.clone(), distance = Math.max(1, 0.78 / qa.state.camera.aspect);
        // A long wall-crossing route must stay between the preview, palette and toolbar.
        if (routeTarget) target.lerp(new qa.THREE.Vector3(...routeTarget), 0.5);
        qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(routeTarget ? 0 : 560, 720, 950).multiplyScalar(distance));
        qa.state.controls.target.copy(target); qa.state.velocity.set(0, 0, 0); qa.state.controls.update();
        return speed;
    }, routeTarget);
    let start, end, before;
    try {
        start = await trainPoint(page);
        const target = await page.evaluate(() => qa.state.train.position.toArray());
        end = await project(page, routeTarget || [target[0] + 190, 0, target[2] - 140]);
        assert.ok(await page.evaluate(end => document.elementFromPoint(end.x, end.y) === qa.state.renderer.domElement, end), 'Route release must land on the playable canvas, not a UI button');
        before = await cameraState(page);
        if (touchSession) await touchEvent(touchSession, 'touchStart', [start]);
        else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
    } finally { await page.evaluate(speed => { qa.state.gameSpeed = speed; }, speed); }
    for (let i = 1; i <= 8; i++) {
        const point = { x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8 };
        if (touchSession) await touchEvent(touchSession, 'touchMove', [point]);
        else await page.mouse.move(point.x, point.y);
    }
    check(touchSession ? 'Touch drag draws a train route' : 'Mouse drag draws a train route', await page.evaluate(() => qa.state.train.drawing && Boolean(qa.state.train.pathVisual?.parent)));
    assertCamera(before, await cameraState(page));
    check(touchSession ? 'Touch train drawing keeps the camera fixed' : 'Mouse train drawing keeps the camera fixed', true);
    return { end, before };
}
async function advance(page, seconds) {
    // Advance the real fixed-step systems after genuine pointer input; avoid
    // spending many rendered seconds on route following and decoration expiry.
    await page.evaluate(seconds => {
        for (let i = 0; i < Math.ceil(seconds * 60); i++) {
            qa.state.world.step(1 / 60); qa.updateTrain(1 / 60); qa.updateDogs(1 / 60); qa.updateFoods(1 / 60); qa.updateMagicEffects(qa.animals, 1 / 60); qa.syncTrainRopes();
            for (const puff of qa.state.train?.steam || []) {
                if (puff.life > 0 && puff.mesh.visible) qa.trainSteamSeen[puff.emphasized ? 'ping' : 'ordinary'] = true;
            }
        }
    }, seconds);
}
async function checkFinishedRoute(page, label) {
    const before = await page.evaluate(() => ({ position: qa.state.train.position.toArray(), endpoint: qa.state.train.route.at(-1)?.toArray(), routeLength: qa.state.train.route.length }));
    check(`${label} release starts the route and unlocks the camera`, await page.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled && qa.state.train.route.length >= 2));
    assert.ok(before.endpoint);
    await advance(page, 1.5);
    check(`${label} train moves along the drawn route`, await page.evaluate(before => {
        const p = qa.state.train.position, start = new qa.THREE.Vector3(...before.position), end = new qa.THREE.Vector3(...before.endpoint);
        return p.distanceTo(start) > 20 && p.distanceTo(end) < start.distanceTo(end);
    }, before));
    await advance(page, 5);
    check(`${label} route light fades after drawing`, await page.evaluate(() => !qa.state.train.pathVisual || !qa.state.train.pathVisual.parent || !qa.state.train.pathVisual.visible));
}
async function checkBalloonDeparture(page, touch = false) {
    const label = touch ? 'Mobile' : 'Desktop';
    for (let i = 0; i < 4; i++) {
        if (await page.evaluate(() => qa.state.currentMode === 'food' && qa.state.snackIngredients.length === 1 && qa.state.snackIngredients[0] === 'balloon')) break;
        await page.locator('#btn-food')[touch ? 'tap' : 'click']();
    }
    const previousSpeed = await page.evaluate(() => {
        const speed = qa.state.gameSpeed; qa.state.gameSpeed = 0;
        const target = new qa.THREE.Box3().setFromObject(qa.near.mesh).getCenter(new qa.THREE.Vector3());
        const distance = Math.max(1, 0.78 / qa.state.camera.aspect);
        qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(350, 400, 550).multiplyScalar(distance));
        qa.state.controls.target.copy(target); qa.state.velocity.set(0, 0, 0); qa.state.controls.update();
        return speed;
    });
    try {
        const point = await page.evaluate(() => {
            qa.state.scene.updateMatrixWorld(true); qa.state.camera.updateMatrixWorld(true);
            const candidates = [], ray = new qa.THREE.Raycaster();
            const targets = [...qa.objects, qa.state.train.mesh, ...qa.animals.map(animal => animal.mesh), ...qa.foods.filter(food => !food.eaten && food.consumeTimer < 0).map(food => food.mesh)];
            qa.near.mesh.traverse(part => {
                if (!part.isMesh || !part.visible) return;
                const bounds = new qa.THREE.Box3().setFromObject(part), p = bounds.getCenter(new qa.THREE.Vector3()).project(qa.state.camera);
                const x = (p.x + 1) * innerWidth / 2, y = (1 - p.y) * innerHeight / 2;
                if (p.z <= -1 || p.z >= 1 || document.elementFromPoint(x, y) !== qa.state.renderer.domElement) return;
                ray.setFromCamera(new qa.THREE.Vector2(p.x, p.y), qa.state.camera);
                let hit = ray.intersectObjects(targets, true)[0]?.object;
                while (hit && !hit.userData.animalRef && !hit.userData.trainRef && !hit.userData.foodRef) hit = hit.parent;
                if (hit?.userData.animalRef === qa.near) candidates.push({ x, y, size: bounds.getSize(new qa.THREE.Vector3()).lengthSq() });
            });
            candidates.sort((a, b) => b.size - a.size);
            if (!candidates.length) throw new Error(`No visible passenger surface: ${qa.near.animalType}, mode=${qa.state.currentMode}, foods=${qa.foods.length}`);
            return candidates[0];
        });
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        const result = await page.evaluate(point => {
            const train = qa.state.train;
            const passed = Boolean(qa.near.magicEffect?.ingredients.includes('balloon') && !qa.near.trainRide && train.followers.length === 1 && train.followers[0] === qa.far && train.ropes.length === 1 && train.ropes[0].from === train && train.ropes[0].to === qa.far && qa.foods.length === 0);
            return { passed, point, mode: qa.state.currentMode, foods: qa.foods.length, effect: qa.near.magicEffect?.ingredients || null, animal: qa.near.animalType, passenger: Boolean(qa.near.trainRide), followers: train.followers.length, ropes: train.ropes.length };
        }, point);
        check(`${label} directly feeding a passenger balloon immediately releases it and reconnects the rope`, result.passed, result.passed ? undefined : result);
    } finally { await page.evaluate(speed => { qa.state.gameSpeed = speed; }, previousSpeed); }
    await advance(page, 1);
    check(`${label} a floating animal stays out of the train and its ropes`, await page.evaluate(() => qa.near.magicEffect?.ingredients.includes('balloon') && !qa.near.trainRide && !qa.state.train.followers.includes(qa.near) && qa.state.train.ropes.length === qa.state.train.followers.length && qa.state.train.ropes.every(rope => rope.from !== qa.near && rope.to !== qa.near)));
}
async function checkWallBreakthrough(page) {
    await resetFixture(page);
    await page.evaluate(() => {
        qa.wallPassengers = [qa.spawnDog('hop'), qa.spawnDog('quad')];
        qa.wallPassengers.forEach((animal, index) => {
            const x = -380 - index * 120;
            animal.mesh.position.set(x, 0, -40); animal.body.position.set(x, animal.heightOffset * (qa.voxelSize / 20), -40);
            animal.body.velocity.set(0, 0, 0); animal.state = 'idle'; animal.timer = 100; animal.isCarnivore = false;
        });
    });
    await placeTrain(page, [-250, 0, 0]); await advance(page, 1.5);
    await page.evaluate(() => {
        qa.state.gameSpeed = 0;
        const start = qa.state.train.position.clone();
        qa.wallX = Math.round((start.x + 225 - 25) / 50) * 50 + 25;
        const centerZ = Math.round((start.z - 25) / 50) * 50 + 25;
        qa.wallBlocks = [];
        for (let z = -250; z <= 250; z += 50) for (const y of [25, 75]) {
            const position = new qa.THREE.Vector3(qa.wallX, y, centerZ + z);
            qa.placeVoxel(position, 'preset-9', true);
            qa.wallBlocks.push(qa.objects.find(block => block !== qa.state.plane && block.position.equals(position)));
        }
        qa.wallGoal = start.add(new qa.THREE.Vector3(650, 0, 0)).toArray();
    });
    const goal = await page.evaluate(() => qa.wallGoal);
    await startDrawing(page, undefined, goal);
    check('A real train drag accepts a route beyond the block wall', await page.evaluate(() => qa.state.train.route.at(-1).x > qa.wallX + 250));
    check('Drawing across a wall leaves every block intact until the train drives into it', await page.evaluate(() => qa.wallBlocks.every(block => block && qa.objects.includes(block))));
    const drawnRoute = await page.evaluate(() => qa.state.train.route.map(point => point.toArray()));
    await page.mouse.up();
    assert.ok(await page.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled && qa.state.train.route.length >= 2), 'Wall route must be committed before driving');
    assert.deepEqual(await page.evaluate(() => qa.state.train.route.map(point => point.toArray())), drawnRoute, 'Releasing the mouse must preserve the drawn wall-crossing route');
    const crossing = await page.evaluate(() => {
        let passed = false;
        for (let i = 0; i < 60 * 25; i++) {
            qa.state.world.step(1 / 60); qa.updateTrain(1 / 60); qa.updateDogs(1 / 60); qa.updateFoods(1 / 60); qa.updateMagicEffects(qa.animals, 1 / 60); qa.syncTrainRopes();
            if (qa.state.train.position.x > qa.wallX + 80 && qa.wallPassengers.every(animal => animal.body.position.x > qa.wallX + 60)) { passed = true; break; }
        }
        return { passed, removed: qa.wallBlocks.filter(block => !qa.objects.includes(block)).length, wallX: qa.wallX, trainX: qa.state.train.position.x, passengerX: qa.wallPassengers.map(animal => animal.body.position.x), passengers: qa.state.train.followers.length, ropes: qa.state.train.ropes.length };
    });
    check('The moving train destroys blocks when it contacts the wall', crossing.removed > 0, crossing);
    check('The locomotive and both animals pass through the broken wall together', crossing.passed && crossing.passengers === 2 && crossing.ropes === 2, crossing);
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        if (process.argv.includes('--capacity-only')) {
            for (const touch of [false,true]) {
                const page = await browser.newPage({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch });
                const errors = []; page.on('pageerror', error => errors.push(error.message));
                await initialize(page,url); await resetFixture(page);
                await page.locator('#btn-train')[touch ? 'tap' : 'click']();
                assert.ok(await page.evaluate(() => qa.state.train?.mesh.parent));
                await checkAnimalCap(page,touch);
                check(`${touch ? 'Mobile' : 'Desktop'} capacity checks have no runtime errors`,errors.length === 0,errors);
                await page.close();
            }
            console.log('RESULT',checks.length,'train capacity browser checks passed');
            return;
        }
        if (!process.argv.includes('--mobile-only')) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await initialize(page, url); await resetFixture(page);
            await page.locator('#btn-train').click(); await page.locator('#btn-train').click();
            check('Train button clicks immediately summon one locomotive without a floor click', await page.evaluate(() => qa.state.currentMode === 'train' && qa.state.train?.mesh.parent && qa.state.scene.children.filter(child => child.name === 'friend-train').length === 1 && qa.objects.length === 1 && qa.foods.length === 0 && document.getElementById('btn-train').classList.contains('active')));
            for (const key of ['Enter', 'Space']) {
                await page.evaluate(() => { qa.previousButtonTrain = qa.state.train; });
                await page.locator('#btn-train').focus(); await page.keyboard.press(key);
                check(`${key} summons a replacement train immediately and disposes the previous engine`, await page.evaluate(() => qa.state.train && qa.state.train !== qa.previousButtonTrain && !qa.previousButtonTrain.mesh.parent && qa.state.scene.children.filter(child => child.name === 'friend-train').length === 1));
            }
            await page.screenshot({ path: '.tmp/qa/train-auto-desktop.png' });
            await checkAnimalCap(page);
            await page.evaluate(() => qa.clearTrain());
            await createPassengerFixture(page);
            await placeTrain(page, [0, 0, 0]);
            await page.evaluate(() => { qa.far.isCarnivore = true; });
            check('A canvas click places one train without a block or snack', await page.evaluate(() => Boolean(qa.state.train.mesh.parent) && qa.objects.length === 1 && qa.foods.length === 0));
            await page.waitForFunction(() => qa.state.train.followers.length > 0, null, { polling: 50 });
            check('The closest ordinary animal joins while the nearer block friend is excluded', await page.evaluate(() => qa.state.train.followers[0] === qa.near && !qa.state.train.followers.includes(qa.blockFriend) && !qa.blockFriend.trainRide));
            await advance(page, 3);
            check('Predator and prey join the same train without the living blocks', await page.evaluate(() => qa.state.train.followers.length === 2 && qa.state.train.followers.includes(qa.near) && qa.state.train.followers.includes(qa.far) && !qa.blockFriend.trainRide));
            await checkRopeChain(page, 'Desktop');
            const travelStart = await captureTravel(page);
            await advance(page, 2);
            check('The train drives automatically and its animal queue moves with it', await page.evaluate(before => qa.state.train.position.distanceTo(new qa.THREE.Vector3(...before.train)) > 20 && qa.near.mesh.position.distanceTo(new qa.THREE.Vector3(...before.friend)) > 20, travelStart));
            await checkRopeMovement(page, travelStart, 'Desktop');
            check('Predator avoidance never breaks the passenger queue', await page.evaluate(() => qa.state.train.followers.includes(qa.near) && qa.state.train.followers.includes(qa.far) && Boolean(qa.near.trainRide) && Boolean(qa.far.trainRide)));
            // Recenter only the camera as preparation for a visible train pick.
            await page.evaluate(() => {
                const target = qa.state.train.position;
                qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(560, 720, 950)); qa.state.controls.target.copy(target); qa.state.controls.update();
            });
            await startDrawing(page);
            const paused = await page.evaluate(() => qa.state.train.position.toArray()); await advance(page, 0.5);
            check('The train pauses while a route is being drawn', await page.evaluate(position => qa.state.train.position.distanceTo(new qa.THREE.Vector3(...position)) < 1e-6, paused));
            await page.screenshot({ path: '.tmp/qa/train-desktop.png' });
            await page.mouse.up(); await checkFinishedRoute(page, 'Desktop');
            await startDrawing(page); await page.keyboard.press('Escape'); await page.mouse.up();
            check('Escape cancels route drawing and releases camera controls', await page.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled));
            await startDrawing(page); await page.locator('#btn-food').click(); await page.mouse.up();
            check('Changing tools cancels route drawing', await page.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled && qa.state.currentMode === 'food'));
            await checkBalloonDeparture(page);
            await page.evaluate(() => {
                qa.oldTrainMesh = qa.state.train.mesh; qa.oldRopeGroup = qa.state.train.ropeGroup; qa.oldRopes = qa.state.train.ropes;
                const geometries = new Set(), materials = new Set();
                qa.oldRopeGroup.traverse(part => {
                    if (part.geometry) geometries.add(part.geometry);
                    if (part.material) (Array.isArray(part.material) ? part.material : [part.material]).forEach(material => materials.add(material));
                });
                qa.ropeDisposal = { geometries: 0, materials: 0, expectedGeometries: geometries.size, expectedMaterials: materials.size };
                geometries.forEach(geometry => geometry.addEventListener('dispose', () => qa.ropeDisposal.geometries++));
                materials.forEach(material => material.addEventListener('dispose', () => qa.ropeDisposal.materials++));
            });
            await page.evaluate(() => { qa.state.camera.position.set(560, 720, 950); qa.state.controls.target.set(0, 0, 0); qa.state.controls.update(); });
            await placeTrain(page, [-250, 0, 200]);
            check('Another floor click relocates the single train', await page.evaluate(() => qa.state.train.position.distanceTo(new qa.THREE.Vector3(-250, 0, 200)) < 35 && (qa.oldTrainMesh === qa.state.train.mesh || !qa.oldTrainMesh.parent)));
            check('Relocating the train removes old ropes and disposes each shared resource once', await page.evaluate(() => !qa.oldRopeGroup.parent && qa.oldRopes.length === 0 && qa.ropeDisposal.expectedGeometries > 0 && qa.ropeDisposal.expectedMaterials > 0 && qa.ropeDisposal.geometries === qa.ropeDisposal.expectedGeometries && qa.ropeDisposal.materials === qa.ropeDisposal.expectedMaterials));
            await page.locator('#btn-clear-all').click(); const removePoint = await trainPoint(page); await page.mouse.click(removePoint.x, removePoint.y);
            check('The broom removes an individual train, its ropes and all passenger references', await page.evaluate(() => !qa.state.train && qa.animals.every(animal => !animal.trainRide) && !qa.state.scene.children.some(child => child.name === 'train-friend-ropes')));
            await placeTrain(page, [0, 0, 0]);
            await page.evaluate(() => document.getElementById('btn-clear-all').addEventListener('pointerdown', () => { qa.broomHoldStarted = performance.now(); }, { once: true }));
            const broom = await page.locator('#btn-clear-all').boundingBox(); await page.mouse.move(broom.x + broom.width / 2, broom.y + broom.height / 2); await page.mouse.down();
            try {
                // Software rendering can delay the browser timer beyond a fixed Node-side sleep.
                await page.waitForFunction(() => !qa.state.train, null, { polling: 50 });
                check('Holding the broom for two seconds also clears the train', await page.evaluate(() => performance.now() - qa.broomHoldStarted >= 2000));
            } finally { await page.mouse.up(); }
            await page.evaluate(() => { qa.clearAllAnimals(); qa.clearAllFood(); });
            await placeTrain(page, [0, 0, 0]); await page.locator('#btn-explode').click();
            await page.waitForFunction(() => !qa.state.train, null, { polling: 50 });
            check('The bomb clears a train even when no blocks or animals remain', await page.evaluate(() => !qa.state.train && qa.objects.length === 1 && qa.animals.length === 0));
            await checkWallBreakthrough(page);
            check('No desktop train runtime exceptions', errors.length === 0, errors); await page.close();
        }
        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const errors = []; mobile.on('pageerror', error => errors.push(error.message));
        await initialize(mobile, url); await resetFixture(mobile);
        await mobile.locator('#btn-train').tap();
        check('One mobile toolbar tap immediately summons a train on visible empty ground', await mobile.evaluate(() => {
            if (!qa.state.train?.mesh.parent) return false;
            const point = qa.state.train.position.clone().setY(45).project(qa.state.camera);
            return document.elementFromPoint((point.x + 1) * innerWidth / 2, (1 - point.y) * innerHeight / 2) === qa.state.renderer.domElement && qa.objects.length === 1 && qa.foods.length === 0;
        }));
        await mobile.screenshot({ path: '.tmp/qa/train-auto-mobile.png' });
        await checkAnimalCap(mobile, true);
        await mobile.evaluate(() => qa.clearTrain());
        await createPassengerFixture(mobile, true);
        await placeTrain(mobile, [0, 0, 0], true);
        await mobile.evaluate(() => { qa.far.isCarnivore = true; });
        check('A real mobile tap places a train without editing blocks', await mobile.evaluate(() => Boolean(qa.state.train) && qa.objects.length === 1));
        await advance(mobile, 3);
        check('Mobile excludes the nearest living blocks and recruits ordinary prey then predator', await mobile.evaluate(() => qa.state.train.followers.length === 2 && qa.state.train.followers[0] === qa.near && qa.state.train.followers[1] === qa.far && !qa.blockFriend.trainRide));
        await checkRopeChain(mobile, 'Mobile');
        const mobileTravel = await captureTravel(mobile); await advance(mobile, 2);
        await checkRopeMovement(mobile, mobileTravel, 'Mobile');
        const touch = await mobile.context().newCDPSession(mobile);
        await startDrawing(mobile, touch);
        await mobile.screenshot({ path: '.tmp/qa/train-mobile.png' });
        await touchEvent(touch, 'touchEnd', []); await checkFinishedRoute(mobile, 'Mobile');
        check('Mobile movement emits ordinary steam and occasional ping bursts', await mobile.evaluate(() => qa.trainSteamSeen.ordinary && qa.trainSteamSeen.ping));
        const drawing = await startDrawing(mobile, touch);
        await touchEvent(touch, 'touchStart', [drawing.end, { x: drawing.end.x - 35, y: drawing.end.y + 35 }]);
        await touchEvent(touch, 'touchEnd', []);
        check('A second finger cancels train drawing and unlocks camera controls', await mobile.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled));
        await checkBalloonDeparture(mobile, true);
        for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
            await mobile.setViewportSize(viewport); await mobile.locator('#btn-train').tap(); await mobile.locator('#btn-train').tap();
            const layout = await mobile.evaluate(() => {
                const buttons = [...document.querySelectorAll('#edit-mode-panel .mode-btn')].map(button => {
                    const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2), panel = button.parentElement.getBoundingClientRect();
                    return { id: button.id, width: r.width, height: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, unclipped: r.left >= panel.left && r.top >= panel.top && r.right <= panel.right && r.bottom <= panel.bottom, clickable: hit === button || button.contains(hit) };
                });
                return { buttons, overflow: document.documentElement.scrollWidth > innerWidth, mode: qa.state.currentMode, trainActive: document.getElementById('btn-train').classList.contains('active'), blocks: qa.objects.length };
            });
            const fits = !layout.overflow && layout.mode === 'train' && layout.trainActive && layout.blocks === 1 && layout.buttons.some(button => button.id === 'btn-train') && layout.buttons.every(button => button.inside && button.unclipped && button.clickable && button.width >= 40 && button.height >= 40);
            check(`Train toolbar fits and taps activate once at ${viewport.width}x${viewport.height}`, fits, fits ? { width: viewport.width, height: viewport.height, buttons: layout.buttons.length } : layout);
            await mobile.screenshot({ path: `.tmp/qa/train-mobile-${viewport.width}x${viewport.height}.png` });
        }
        check('No mobile train runtime exceptions', errors.length === 0, errors);
        await mobile.close(); console.log('RESULT', checks.length, 'train browser checks passed');
    } catch (error) {
        for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: '.tmp/qa/train-failure.png' }).catch(() => {});
        throw error;
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
