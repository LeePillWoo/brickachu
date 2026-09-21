const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
process.chdir(root);
fs.mkdirSync('.tmp/qa', { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
    const name = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!name.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(name, (error, data) => {
        res.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(error ? 'Not found' : data);
    });
});
const checks = [];
const dependencyCache = new Map();
async function preparePage(page) {
    page.setDefaultTimeout(45000);
    await page.route('**/www.googletagmanager.com/**', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    // Reuse the exact CDN responses across desktop/mobile contexts so test
    // timing does not depend on repeatedly downloading the same modules.
    await page.route('https://unpkg.com/**', async route => {
        const url = route.request().url();
        if (!dependencyCache.has(url)) dependencyCache.set(url, fetch(url).then(async response => {
            if (!response.ok) throw new Error(`Dependency ${response.status}: ${url}`);
            return Buffer.from(await response.arrayBuffer());
        }));
        await route.fulfill({ body: await dependencyCache.get(url), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
}
function check(name, condition, details) { assert.ok(condition, `${name}: ${JSON.stringify(details)}`); checks.push(name); console.log('PASS', name, details ?? ''); }
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE', message.text()); });
        page.on('requestfailed', request => console.log('REQUEST FAILED', request.url(), request.failure()?.errorText));
        await preparePage(page);
        await page.goto(url);
        await page.waitForFunction(async () => (await import(new URL('js/state.js', document.baseURI).href)).state.previewRenderer !== null, null, { timeout: 45000 });
        await page.evaluate(async () => {
            const load = file => import(new URL('js/' + file, document.baseURI).href);
            window.qa = { ...await load('state.js'), ...await load('scene.js'), ...await load('entities.js'), ...await load('food.js'), ...await load('input.js'), THREE: await import('three') };
        });
        check('Game initializes without exceptions', errors.length === 0, errors);
        const point = await page.evaluate(() => {
            const p = new qa.THREE.Vector3(200, 0, 200).project(qa.state.camera);
            return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
        });
        await page.mouse.click(point.x, point.y);
        let n = await page.evaluate(() => qa.objects.length - 1);
        check('One left click places exactly one block', n === 1, n);
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.mouse.click(point.x, point.y, { button: 'middle' });
        check('Right/middle clicks leave blocks unchanged', await page.evaluate(() => qa.objects.length - 1) === 1);
        await page.keyboard.press('Control+z');
        check('Undo removes the whole single-click action', await page.evaluate(() => qa.objects.length - 1) === 0);
        await page.keyboard.press('Control+y');
        check('Redo restores the single block', await page.evaluate(() => qa.objects.length - 1) === 1);
        await page.locator('#btn-food').click();
        check('One snack toolbar click selects balloon immediately', await page.evaluate(() => qa.state.currentMode === 'food' && JSON.stringify(qa.state.snackIngredients) === '["balloon"]' && document.getElementById('btn-food').textContent.trim() === '🎈'));
        const foodPoint = await page.evaluate(() => {
            const p = new qa.THREE.Vector3(-200, 0, 200).project(qa.state.camera);
            return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
        });
        await page.mouse.click(foodPoint.x, foodPoint.y);
        const foodResult = await page.evaluate(() => ({ foods: qa.foods.length, objects: qa.objects.length, mode: qa.state.currentMode }));
        check('Food placement does not add a block', foodResult.foods === 1 && foodResult.objects === 2, foodResult);
        await page.evaluate(() => {
            const block = qa.objects[1];
            qa.clearAllFood();
            qa.spawnFood(new qa.THREE.Vector3(block.position.x, block.position.y + 25, block.position.z));
            qa.removeVoxel(block);
        });
        check('Removing food support triggers a fall', await page.evaluate(() => qa.foods[0].falling));
        await page.waitForFunction(() => !qa.foods[0].falling, null, { timeout: 15000 });
        const landingY = await page.evaluate(() => qa.foods[0].position.y);
        check('Food lands at the real floor', Math.abs(landingY) < 1e-6, landingY);
        const snapshots = await page.evaluate(() => {
            qa.clearAllFood();
            qa.placeVoxel(new qa.THREE.Vector3(25, 25, 25));
            qa.placeVoxel(new qa.THREE.Vector3(75, 25, 25));
            const before = qa.getFullSnapshot();
            qa.explodeBricks();
            const emptyPreview = qa.state.previewObjects.length === 0;
            qa.undo();
            const undoMatches = qa.getFullSnapshot() === before;
            qa.redo();
            const redoEmpty = qa.objects.length === 1;
            qa.restoreBricks();
            return { emptyPreview, undoMatches, redoEmpty, restored: qa.getFullSnapshot() === before, physicsCount: qa.state.world.bodies.length };
        });
        check('Explosion / undo / redo / restore keep scene and preview in sync', Object.entries(snapshots).filter(([k]) => k !== 'physicsCount').every(([,v]) => v), snapshots);
        await page.setViewportSize({ width: 1000, height: 700 });
        await page.waitForTimeout(100);
        check('Postprocessing resizes with canvas', await page.evaluate(() => qa.state.composer.renderTarget1.width === qa.state.renderer.domElement.width && qa.state.composer.renderTarget1.height === qa.state.renderer.domElement.height));
        const animals = await page.evaluate(() => {
            qa.clearAllAnimals();
            for (const group of ['quad', 'hop', 'sneak', 'heavy', 'waddle', 'special', 'carnivore']) qa.spawnDog(group);
            return qa.animals.map(a => ({ type: a.animalType, group: a.animGroup }));
        });
        check('All animal groups spawn', animals.length === 7, animals);
        await page.waitForTimeout(2500);
        await page.evaluate(() => qa.animals.forEach(a => qa.triggerClickAction(a)));
        await page.waitForTimeout(2500);
        check('Animal actions keep physics finite', await page.evaluate(() => qa.animals.every(a => [a.body.position.x,a.body.position.y,a.body.position.z,a.mesh.scale.x].every(Number.isFinite))));
        await page.evaluate(() => qa.clearAllAnimals());
        const animalButton = await page.locator('#add-dog-btn').boundingBox();
        await page.mouse.move(animalButton.x + animalButton.width / 2, animalButton.y + animalButton.height / 2);
        await page.mouse.down();
        await page.waitForFunction(() => document.getElementById('animal-type-menu').style.display === 'flex', null, { polling: 50 });
        await page.mouse.up();
        check('Long press keeps animal selection menu open', await page.locator('#animal-type-menu').isVisible());
        await page.locator('.atm-item[data-group="heavy"]').click();
        await page.locator('#add-dog-btn').click();
        check('Selected group spawns a heavy animal', await page.evaluate(() => qa.animals.at(-1).animGroup === 'HEAVY'));
        const countBeforeCancel = await page.evaluate(() => qa.animals.length);
        const clearButton = await page.locator('#btn-clear-all').boundingBox();
        await page.mouse.move(clearButton.x + clearButton.width / 2, clearButton.y + clearButton.height / 2);
        await page.mouse.down();
        await page.mouse.move(500, 500);
        await page.waitForTimeout(2100);
        await page.mouse.up();
        check('Moving off clear button cancels mass deletion', await page.evaluate(() => qa.animals.length) === countBeforeCancel);
        await page.mouse.move(clearButton.x + clearButton.width / 2, clearButton.y + clearButton.height / 2);
        await page.mouse.down();
        await page.waitForFunction(() => qa.animals.length === 0, null, { polling: 50 });
        await page.mouse.up();
        check('Holding clear for two seconds removes animals and food', await page.evaluate(() => qa.animals.length === 0 && qa.foods.length === 0));
        await page.evaluate(() => { for (const group of ['quad','hop','heavy','special']) qa.spawnDog(group); });
        await page.screenshot({ path: '.tmp/qa/desktop.png' });
        await page.evaluate(() => { qa.clearAllAnimals(); qa.clearAllFood(); });
        check('Animal and food clearing empties the active arrays', await page.evaluate(() => qa.animals.length === 0 && qa.foods.length === 0));
        check('No runtime exceptions through interactions', errors.length === 0, errors);

        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const mobileErrors = [];
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await preparePage(mobile);
        await mobile.goto(url);
        await mobile.waitForFunction(async () => (await import(new URL('js/state.js', document.baseURI).href)).state.previewRenderer !== null);
        await mobile.evaluate(async () => {
            const load = file => import(new URL('js/' + file, document.baseURI).href);
            window.qa = { ...await load('state.js'), ...await load('food.js'), THREE: await import('three') };
        });
        await mobile.touchscreen.tap(195, 500);
        check('Mobile tap places one block', await mobile.evaluate(() => qa.objects.length === 2));
        const cdp = await mobile.context().newCDPSession(mobile);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 500 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 245, y: 500 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        check('Mobile orbit drag does not build blocks', await mobile.evaluate(() => qa.objects.length === 2));
        await mobile.locator('#btn-food').tap();
        check('A mobile snack toolbar tap advances exactly once', await mobile.evaluate(() => qa.state.currentMode === 'food' && JSON.stringify(qa.state.snackIngredients) === '["balloon"]' && document.getElementById('btn-food').textContent.trim() === '🎈' && qa.objects.length === 2 && qa.foods.length === 0));
        await mobile.touchscreen.tap(195, 370);
        check('Mobile food mode places food without building', await mobile.evaluate(() => qa.foods.length === 1 && qa.objects.length === 2));
        await mobile.screenshot({ path: '.tmp/qa/mobile.png' });
        check('Mobile interaction has no runtime exceptions', mobileErrors.length === 0, mobileErrors);
        await mobile.close();

        const timed = page;
        await timed.bringToFront();
        await timed.evaluate(() => {
            window.qaFrames = [];
            window.requestAnimationFrame = callback => { qaFrames.push(callback); return qaFrames.length; };
            qa.state.composer.render = () => {};
            qa.state.previewRenderer.render = () => {};
        });
        await timed.waitForFunction(() => qaFrames.length > 0, null, { polling: 50 });
        const timing = await timed.evaluate(async () => {
            const { state } = await import(new URL('js/state.js', document.baseURI).href);
            state.composer.render = () => {};
            state.previewRenderer.render = () => {};
            let now = performance.now();
            const frame = () => { const callbacks = qaFrames.splice(0); callbacks.forEach(callback => callback(now)); };
            frame();
            const result = [];
            for (const speed of [1,2,3]) for (const fps of [30,60,144]) {
                state.gameSpeed = speed;
                const before = state.world.time;
                for (let i = 0; i < fps; i++) { now += 1000/fps; frame(); }
                result.push({ speed, fps, elapsed: state.world.time - before });
            }
            state.gameSpeed = 1;
            const original = state.camera.position.clone();
            state.screenShakeTimer = 0.5;
            state.screenShakeIntensity = 15;
            for (let i = 0; i < 60; i++) { now += 1000/60; frame(); }
            return { cases: result, shakeDrift: original.distanceTo(state.camera.position) };
        });
        check('30/60/144 Hz all preserve x1/x2/x3 game speed', timing.cases.every(row => Math.abs(row.elapsed - row.speed) < 1e-6), timing.cases);
        check('Heavy action camera shake leaves no camera drift', timing.shakeDrift < 1e-6, timing.shakeDrift);
        await timed.close();
        console.log('RESULT', checks.length, 'checks passed');
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
