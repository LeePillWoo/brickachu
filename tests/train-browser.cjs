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
    const point = await project(page, position);
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => Boolean(qa.state.train?.mesh.parent));
}
async function touchEvent(session, type, points) {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id, radiusX: 1, radiusY: 1, force: 1 })) });
}
async function startDrawing(page, touchSession) {
    await page.evaluate(() => {
        const target = qa.state.train.position, distance = Math.max(1, 0.78 / qa.state.camera.aspect);
        qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(560, 720, 950).multiplyScalar(distance));
        qa.state.controls.target.copy(target); qa.state.velocity.set(0, 0, 0); qa.state.controls.update();
    });
    const start = await trainPoint(page);
    const target = await page.evaluate(() => qa.state.train.position.toArray());
    const end = await project(page, [target[0] + 190, 0, target[2] - 140]);
    const before = await cameraState(page);
    if (touchSession) await touchEvent(touchSession, 'touchStart', [start]);
    else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
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
            qa.state.world.step(1 / 60); qa.updateTrain(1 / 60); qa.updateDogs(1 / 60); qa.updateFoods(1 / 60); qa.updateMagicEffects(qa.animals, 1 / 60);
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
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        if (!process.argv.includes('--mobile-only')) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await initialize(page, url); await resetFixture(page);
            await page.locator('#btn-train').click(); await page.locator('#btn-train').click();
            check('Repeated train button clicks keep train mode without creating anything', await page.evaluate(() => qa.state.currentMode === 'train' && !qa.state.train && qa.objects.length === 1 && document.getElementById('btn-train').classList.contains('active')));
            await page.evaluate(() => {
                qa.far = qa.spawnDog('carnivore');
                qa.placeVoxel(new qa.THREE.Vector3(-75, 25, -75), 'preset-10', true);
                qa.placeVoxel(new qa.THREE.Vector3(-75, 75, -75), 'preset-9', true);
                qa.pushHistory();
            });
            await page.locator('#btn-eyes').click();
            const head = await project(page, [-75, 75, -49]); await page.mouse.click(head.x, head.y);
            check('A real eyes click creates the block friend used in the train', await page.evaluate(() => qa.animals.some(animal => animal.livingId) && qa.objects.length === 1));
            await page.evaluate(() => {
                qa.near = qa.animals.find(animal => animal.livingId);
                for (const [animal, x] of [[qa.near, -90], [qa.far, -190]]) {
                    animal.mesh.position.set(x, 0, -40); animal.body.position.set(x, animal.heightOffset * (qa.voxelSize / 20), -40);
                    animal.body.velocity.set(0, 0, 0); animal.state = 'idle'; animal.timer = 100; animal.isCarnivore = false;
                }
                // Keep the fixture motionless until the train exists, then turn
                // the ordinary animal back into a predator to test the contract.
            });
            await placeTrain(page, [0, 0, 0]);
            await page.evaluate(() => { qa.far.isCarnivore = true; });
            check('A canvas click places one train without a block or snack', await page.evaluate(() => Boolean(qa.state.train.mesh.parent) && qa.objects.length === 1 && qa.foods.length === 0));
            await page.waitForFunction(() => qa.state.train.followers.length > 0, null, { polling: 50 });
            check('The closest block friend joins before the farther ordinary animal', await page.evaluate(() => qa.state.train.followers[0] === qa.near));
            await advance(page, 3);
            check('Predator and prey join the same train', await page.evaluate(() => qa.state.train.followers.includes(qa.near) && qa.state.train.followers.includes(qa.far)));
            const travelStart = await page.evaluate(() => ({ train: qa.state.train.position.toArray(), friend: qa.near.mesh.position.toArray() }));
            await advance(page, 2);
            check('The train drives automatically and its animal queue moves with it', await page.evaluate(before => qa.state.train.position.distanceTo(new qa.THREE.Vector3(...before.train)) > 20 && qa.near.mesh.position.distanceTo(new qa.THREE.Vector3(...before.friend)) > 20, travelStart));
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
            await page.evaluate(() => { qa.oldTrainMesh = qa.state.train.mesh; });
            await page.evaluate(() => { qa.state.camera.position.set(560, 720, 950); qa.state.controls.target.set(0, 0, 0); qa.state.controls.update(); });
            await placeTrain(page, [-250, 0, 200]);
            check('Another floor click relocates the single train', await page.evaluate(() => qa.state.train.position.distanceTo(new qa.THREE.Vector3(-250, 0, 200)) < 35 && (qa.oldTrainMesh === qa.state.train.mesh || !qa.oldTrainMesh.parent)));
            await page.locator('#btn-clear-all').click(); const removePoint = await trainPoint(page); await page.mouse.click(removePoint.x, removePoint.y);
            check('The broom removes an individual train and releases all passengers', await page.evaluate(() => !qa.state.train && qa.animals.every(animal => !animal.trainRide)));
            await placeTrain(page, [0, 0, 0]);
            const broom = await page.locator('#btn-clear-all').boundingBox(); await page.mouse.move(broom.x + broom.width / 2, broom.y + broom.height / 2); await page.mouse.down();
            await page.waitForTimeout(2200); await page.mouse.up();
            check('Holding the broom also clears the train', await page.evaluate(() => !qa.state.train));
            await page.evaluate(() => { qa.clearAllAnimals(); qa.clearAllFood(); });
            await placeTrain(page, [0, 0, 0]); await page.locator('#btn-explode').click();
            await page.waitForFunction(() => !qa.state.train, null, { polling: 50 });
            check('The bomb clears a train even when no blocks or animals remain', await page.evaluate(() => !qa.state.train && qa.objects.length === 1 && qa.animals.length === 0));
            check('No desktop train runtime exceptions', errors.length === 0, errors); await page.close();
        }
        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const errors = []; mobile.on('pageerror', error => errors.push(error.message));
        await initialize(mobile, url); await resetFixture(mobile);
        await placeTrain(mobile, [0, 0, 0], true);
        check('A real mobile tap places a train without editing blocks', await mobile.evaluate(() => Boolean(qa.state.train) && qa.objects.length === 1));
        const touch = await mobile.context().newCDPSession(mobile);
        await startDrawing(mobile, touch);
        await mobile.screenshot({ path: '.tmp/qa/train-mobile.png' });
        await touchEvent(touch, 'touchEnd', []); await checkFinishedRoute(mobile, 'Mobile');
        const drawing = await startDrawing(mobile, touch);
        await touchEvent(touch, 'touchStart', [drawing.end, { x: drawing.end.x - 35, y: drawing.end.y + 35 }]);
        await touchEvent(touch, 'touchEnd', []);
        check('A second finger cancels train drawing and unlocks camera controls', await mobile.evaluate(() => !qa.state.train.drawing && qa.state.controls.enabled));
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
