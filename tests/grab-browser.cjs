const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
process.chdir(root);
fs.mkdirSync('.tmp/qa', { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
    const name = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!name.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(name, (error, data) => {
        res.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(error ? 'Not found' : data);
    });
});
const dependencyCache = new Map();
let passed = 0;
function check(name, value, details) { assert.ok(value, `${name}: ${JSON.stringify(details)}`); passed++; console.log('PASS', name); }
async function initialize(page, url) {
    page.setDefaultTimeout(45000);
    await page.route('**/www.googletagmanager.com/**', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    await page.route('https://unpkg.com/**', async route => {
        const url = route.request().url();
        if (!dependencyCache.has(url)) dependencyCache.set(url, fetch(url).then(async response => {
            if (!response.ok) throw new Error(`Dependency ${response.status}: ${url}`);
            return Buffer.from(await response.arrayBuffer());
        }));
        await route.fulfill({ body: await dependencyCache.get(url), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.goto(url);
    await page.waitForFunction(async () => Boolean((await import(new URL('js/state.js', document.baseURI).href)).state.previewRenderer));
    await page.evaluate(async () => {
        const load = name => import(new URL('js/' + name + '.js', document.baseURI).href);
        window.qa = { ...await load('state'), ...await load('entities'), ...await load('scene'), ...await load('food'), ...await load('train'), ...await load('magic'), ...await load('animal-catalog'), THREE: await import('three') };
        qa.state.gameSpeed = 0;
    });
}
async function fixture(page) {
    await page.evaluate(() => {
        qa.clearTrain(); qa.clearAllAnimals(); qa.clearAllFood();
        qa.objects.filter(o => o !== qa.state.plane).forEach(qa.removeVoxel);
        qa.GROUP_ANIMALS.__grabQA = ['dog'];
        qa.friend = qa.spawnDog('__grabQA');
        delete qa.GROUP_ANIMALS.__grabQA;
        qa.friend.body.position.set(0, qa.friend.heightOffset * qa.voxelSize / 20, 0);
        qa.friend.mesh.position.set(0, 0, 0); qa.friend.mesh.rotation.set(0, 0, 0);
        qa.friend.body.velocity.set(0, 0, 0); qa.friend.clickActionTimer = 0;
        const target = new qa.THREE.Vector3(0, 55, 0);
        qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(320, 360, 560).multiplyScalar(Math.max(1, 0.72 / qa.state.camera.aspect)));
        qa.state.controls.target.copy(target); qa.state.velocity.set(0, 0, 0);
        qa.state.controls.update(); qa.state.camera.updateMatrixWorld(true); qa.state.scene.updateMatrixWorld(true);
    });
}
async function animalPoint(page) {
    return page.evaluate(() => {
        qa.state.scene.updateMatrixWorld(true);
        const bounds = new qa.THREE.Box3().setFromObject(qa.friend.mesh);
        const size = bounds.getSize(new qa.THREE.Vector3()), center = bounds.getCenter(new qa.THREE.Vector3());
        for (const offset of [0, 0.15, -0.15, 0.3]) {
            const p = center.clone().add(new qa.THREE.Vector3(0, size.y * offset, 0)).project(qa.state.camera);
            qa.state.raycaster.setFromCamera(new qa.THREE.Vector2(p.x, p.y), qa.state.camera);
            if (qa.state.raycaster.intersectObject(qa.friend.mesh, true).length) return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
        }
        throw new Error('No visible animal surface in fixture');
    });
}
async function touch(session, type, points = []) {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ ...p, id, radiusX: 3, radiusY: 3, force: 1 })) });
}
async function camera(page) { return page.evaluate(() => qa.state.camera.position.toArray()); }
async function assertHolding(page, name) {
    check(name, await page.evaluate(() => qa.friend.grabbed && !qa.state.controls.enabled && qa.friend.mesh.position.y >= 120 && qa.friend.clickActionTimer === 0));
}
async function assertReleased(page, name) {
    check(name, await page.evaluate(() => !qa.friend.grabbed && qa.state.controls.enabled && Math.abs(qa.friend.mesh.position.y) < 0.001 && qa.objects.length === 1 && qa.foods.length === 0));
}
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await initialize(page, url); await fixture(page);
        await page.locator('#btn-grab').click();
        check('Hand toolbar activates exclusively and explains immediate pickup', await page.evaluate(() => qa.state.currentMode === 'grab' && document.getElementById('btn-grab').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('#edit-mode-panel .active').length === 1 && document.getElementById('toy-notice').textContent.includes('잡아')));
        let start = await animalPoint(page);
        const before = await camera(page);
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await assertHolding(page, 'Mouse down immediately lifts the animal without a long press');
        await page.mouse.move(start.x + 80, start.y + 25, { steps: 5 });
        assert.deepEqual(await camera(page), before);
        check('Mouse drag moves the animal without moving the camera', await page.evaluate(() => Math.hypot(qa.friend.mesh.position.x, qa.friend.mesh.position.z) > 30));
        await page.mouse.up(); await assertReleased(page, 'Mouse release lands once without placing blocks or snacks');
        await fixture(page); start = await animalPoint(page);
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await page.keyboard.press('Escape'); await page.mouse.up();
        await assertReleased(page, 'Escape cancels a held animal and restores the camera');
        await page.locator('#btn-add').click(); start = await animalPoint(page);
        await page.mouse.click(start.x, start.y);
        check('Normal animal clicks still trigger its special action', await page.evaluate(() => qa.friend.clickActionTimer > 0 && !qa.friend.grabbed));
        for (const key of ['Enter', 'Space']) {
            await page.locator('#btn-grab').focus(); await page.keyboard.press(key);
            check(`${key} activates hand mode once`, await page.evaluate(() => qa.state.currentMode === 'grab' && document.querySelectorAll('#edit-mode-panel .active').length === 1));
        }
        await page.locator('#btn-animal-category').focus(); await page.keyboard.press('Enter');
        await page.locator('.atm-item[data-group="water"]').focus(); await page.keyboard.press('Enter');
        await page.locator('#add-dog-btn').focus(); await page.keyboard.press('Space');
        check('Keyboard category selection spawns one animal from that category', await page.evaluate(() => qa.animals.length === 2 && qa.ANIMAL_CATEGORIES.find(c => c.id === 'water').types.includes(qa.animals.at(-1).animalType)));
        check('Desktop has no runtime errors', errors.length === 0, errors);
        await page.close();

        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const mobileErrors = [];
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await initialize(mobile, url); await fixture(mobile);
        const session = await mobile.context().newCDPSession(mobile);
        await mobile.locator('#btn-grab').tap(); start = await animalPoint(mobile);
        const mobileBefore = await camera(mobile);
        await touch(session, 'touchStart', [start]);
        await assertHolding(mobile, 'A real touch immediately picks up the animal');
        const end = { x: start.x - 40, y: start.y + 70 };
        await touch(session, 'touchMove', [end]);
        assert.deepEqual(await camera(mobile), mobileBefore);
        check('Touch drag moves the animal while OrbitControls stays locked', await mobile.evaluate(() => Math.hypot(qa.friend.mesh.position.x, qa.friend.mesh.position.z) > 30));
        await mobile.screenshot({ path: '.tmp/qa/grab-mobile.png' });
        await touch(session, 'touchEnd'); await assertReleased(mobile, 'Lifting the finger releases the animal safely');
        await fixture(mobile); start = await animalPoint(mobile);
        await touch(session, 'touchStart', [start]);
        await touch(session, 'touchStart', [start, { x: start.x - 30, y: start.y + 30 }]);
        await touch(session, 'touchEnd'); await assertReleased(mobile, 'A second finger cancels pickup and restores camera controls');
        for (const category of ['all', 'pets', 'forest', 'water', 'tiny', 'magic']) {
            await mobile.locator('#btn-animal-category').tap();
            await mobile.locator(`.atm-item[data-group="${category}"]`).tap();
            const count = await mobile.evaluate(() => qa.animals.length);
            await mobile.locator('#add-dog-btn').tap();
            check(`Touch category ${category} selects and spawns exactly one matching friend`, await mobile.evaluate(({ category, count }) => qa.animals.length === count + 1 && qa.ANIMAL_CATEGORIES.find(c => c.id === category).types.includes(qa.animals.at(-1).animalType), { category, count }));
        }
        for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
            await mobile.setViewportSize(viewport);
            await mobile.locator('#btn-grab').tap();
            const layout = await mobile.evaluate(() => {
                const toolbar = document.getElementById('edit-mode-panel').getBoundingClientRect();
                const buttons = [...document.querySelectorAll('#edit-mode-panel .mode-btn')].map(button => {
                    const r = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    return { id: button.id, fits: r.width >= 44 && r.height >= 44 && r.left >= 0 && r.top >= toolbar.top && r.right <= innerWidth && r.bottom <= Math.min(innerHeight, toolbar.bottom), clickable: hit === button || button.contains(hit) };
                });
                return { buttons, overflow: document.documentElement.scrollWidth > innerWidth, centerClear: document.elementFromPoint(innerWidth * 0.46, innerHeight * 0.46)?.tagName === 'CANVAS' };
            });
            check(`All hand/category/tool buttons fit and remain tappable at ${viewport.width}x${viewport.height}`, !layout.overflow && layout.centerClear && layout.buttons.every(b => b.fits && b.clickable), layout);
            await mobile.locator('#btn-animal-category').tap();
            await mobile.waitForFunction(() => Number(getComputedStyle(document.getElementById('animal-type-menu')).opacity) > 0.99);
            const menu = await mobile.locator('#animal-type-menu').boundingBox();
            check(`Category menu fits ${viewport.width}x${viewport.height}`, menu && menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height);
            await mobile.screenshot({ path: `.tmp/qa/categories-${viewport.width}x${viewport.height}.png` });
            await mobile.locator('.atm-item[data-group="all"]').tap();
        }
        check('Mobile has no runtime errors', mobileErrors.length === 0, mobileErrors);
        await mobile.close();
        console.log(`RESULT ${passed} grab/category browser checks passed`);
    } catch (error) {
        for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: '.tmp/qa/grab-failure.png' }).catch(() => {});
        throw error;
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
