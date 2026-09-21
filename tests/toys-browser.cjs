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
const recipes = [
    { ids: [], icon: '🍎', label: '사과' }, { ids: ['balloon'], icon: '🎈', label: '풍선' },
    { ids: ['jelly'], icon: '🍮', label: '젤리' }, { ids: ['rainbow'], icon: '🌈', label: '무지개' }
];
async function preparePage(page) {
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
}
async function initializeQA(page, url) {
    await page.goto(url);
    await page.waitForFunction(async () => Boolean((await import(new URL('js/state.js', document.baseURI).href)).state.previewRenderer));
    await page.evaluate(async () => {
        const load = file => import(new URL('js/' + file, document.baseURI).href);
        window.qa = { ...await load('state.js'), ...await load('entities.js'), ...await load('scene.js'), ...await load('living.js'), ...await load('magic.js'), ...await load('food.js'), THREE: await import('three') };
    });
}
async function createBuildFixture(page) {
    // Test-only construction: production has no starter button or example API.
    await page.evaluate(() => {
        qa.clearAllAnimals(); qa.clearAllFood();
        qa.objects.filter(block => block !== qa.state.plane).forEach(qa.removeVoxel);
        const center = new qa.THREE.Vector3(25,25,25);
        const pattern = [[-1,0,0,'preset-10'],[1,0,0,'preset-10'],[-1,1,0,'preset-20'],[0,1,0,'preset-20'],[1,1,0,'preset-20'],[0,2,0,'preset-9']];
        for (const [x,y,z,slot] of pattern) qa.placeVoxel(center.clone().add(new qa.THREE.Vector3(x,y,z).multiplyScalar(50)), slot, true);
        qa.pushHistory();
        const target = center.clone().add(new qa.THREE.Vector3(0,50,0));
        qa.state.camera.position.copy(target).add(new qa.THREE.Vector3(320,250,600).multiplyScalar(Math.max(1, 0.72 / qa.state.camera.aspect)));
        qa.state.controls.target.copy(target); qa.state.velocity.set(0,0,0);
        qa.state.controls.update(); qa.state.camera.updateMatrixWorld(true);
    });
}
async function headPoint(page) {
    return page.evaluate(() => {
        const block = qa.objects.filter(o => o !== qa.state.plane).sort((a,b) => b.position.y - a.position.y)[0];
        const point = block.position.clone().add(new qa.THREE.Vector3(0,0,26)).project(qa.state.camera);
        return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
    });
}
async function friendPoint(page) {
    return page.evaluate(() => {
        const point = new qa.THREE.Box3().setFromObject(qa.animals[0].mesh).getCenter(new qa.THREE.Vector3()).project(qa.state.camera);
        return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
    });
}
async function sceneCounts(page) { return page.evaluate(() => ({ blocks: qa.objects.length, food: qa.foods.length, animals: qa.animals.length })); }
async function readToolbar(page) {
    return page.evaluate(() => {
        const food = document.getElementById('btn-food'), eyes = document.getElementById('btn-eyes');
        return {
            recipe: [...qa.state.snackIngredients], mode: qa.state.currentMode,
            icon: food.textContent.trim(), title: food.title, label: food.getAttribute('aria-label'),
            foodPressed: food.getAttribute('aria-pressed'), eyesPressed: eyes.getAttribute('aria-pressed'),
            active: [...document.querySelectorAll('#edit-mode-panel .mode-btn.active')].map(button => button.id)
        };
    });
}
function assertRecipe(toolbar, index) {
    const expected = recipes[index];
    assert.deepEqual(toolbar.recipe, expected.ids); assert.equal(toolbar.icon, expected.icon);
    assert.ok(toolbar.title.includes(expected.label), toolbar.title);
    assert.ok(toolbar.label?.includes(expected.label), toolbar.label);
    assert.equal(toolbar.mode, 'food'); assert.equal(toolbar.foodPressed, 'true');
    assert.equal(toolbar.eyesPressed, 'false'); assert.deepEqual(toolbar.active, ['btn-food']);
}
function check(name, condition, details) { assert.ok(condition, `${name}: ${JSON.stringify(details)}`); checks.push(name); console.log('PASS', name, details ?? ''); }
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        if (!process.argv.includes('--mobile-only')) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await preparePage(page); await initializeQA(page, url);
            check('Eyes and snacks are immediately available on the toolbar', await page.locator('#btn-eyes').isVisible() && await page.locator('#btn-food').isVisible());
            check('The initial snack is an ordinary apple', await page.evaluate(() => qa.state.snackIngredients.length === 0 && document.getElementById('btn-food').textContent.trim() === '🍎'));
            await createBuildFixture(page);
            const beforeTools = await sceneCounts(page);
            await page.locator('#btn-eyes').click(); await page.locator('#btn-eyes').click();
            check('Every eyes click immediately keeps eyes mode active', await page.evaluate(() => qa.state.currentMode === 'eyes' && document.getElementById('btn-eyes').getAttribute('aria-pressed') === 'true'));
            assert.deepEqual(await sceneCounts(page), beforeTools);
            const head = await headPoint(page);
            await page.mouse.move(head.x, head.y);
            check('Eyes hover highlights all six connected blocks', await page.evaluate(() => qa.state.eyesPreview?.visible && qa.state.eyesPreview.children.length === 6));
            await page.mouse.click(head.x, head.y);
            check('A real click awakens the build with two eyes and six physics shapes', await page.evaluate(() => qa.animals.length === 1 && qa.animals[0].livingEyes.children.length === 2 && qa.animals[0].body.shapes.length === 6 && qa.objects.length === 1));
            await page.keyboard.press('Control+z');
            check('Undo restores six editable blocks', await page.evaluate(() => qa.animals.length === 0 && qa.objects.length === 7));
            await page.keyboard.press('Control+Shift+z');
            check('Redo restores one friend without duplicate blocks', await page.evaluate(() => qa.animals.length === 1 && qa.objects.length === 1));
            await page.screenshot({ path: '.tmp/qa/living-desktop.png' });
            const beforeCycle = await sceneCounts(page);
            for (let step = 1; step <= 5; step++) {
                await page.locator('#btn-food').click(); assertRecipe(await readToolbar(page), step % 4);
                assert.deepEqual(await sceneCounts(page), beforeCycle);
            }
            check('Each snack click advances once through apple, balloon, jelly and rainbow', true);
            const beforeFeeding = await page.evaluate(() => qa.animals[0].body.position.y);
            const feed = await friendPoint(page); await page.mouse.click(feed.x, feed.y);
            check('Clicking a friend feeds the selected balloon without dropping food', await page.evaluate(() => JSON.stringify(qa.animals[0].magicEffect?.ingredients) === '["balloon"]' && qa.foods.length === 0));
            await page.waitForFunction(y => qa.animals[0].body.position.y > y + 35, beforeFeeding, { polling: 50 });
            check('Balloon friend inflates, floats and slows down', await page.evaluate(() => {
                const friend = qa.animals[0];
                return friend.mesh.getObjectByName('snack-balloon-shell') !== undefined && friend.mesh.scale.x > 1 && Math.hypot(friend.body.velocity.x, friend.body.velocity.z) <= friend.speed * 0.4 + 1e-6;
            }));
            await page.screenshot({ path: '.tmp/qa/snacks-desktop.png' });
            for (const index of [2,3,0]) { await page.locator('#btn-food').click(); assertRecipe(await readToolbar(page), index); }
            const floating = await friendPoint(page); await page.mouse.click(floating.x, floating.y);
            check('Cycling back to the ordinary apple restores the friend when fed', await page.evaluate(() => !qa.animals[0].magicEffect && qa.animals[0].mesh.scale.equals(qa.animals[0].baseScale)));
            await page.evaluate(() => {
                const animal = qa.animals[0]; qa.applySnack(animal, ['rainbow']);
                animal.body.position.set(25,75,25); animal.mesh.position.set(25,0,25);
                for (let i=0; i<10; i++) { animal.body.position.x += 18; animal.mesh.position.x += 18; qa.updateMagicEffects(qa.animals, 0.13); }
            });
            check('Rainbow footprints never become editable blocks', await page.evaluate(() => qa.state.scene.children.filter(mesh => mesh.userData.magicTrail).length >= 5 && qa.objects.length === 1));
            await page.evaluate(() => qa.updateMagicEffects(qa.animals, 20));
            check('Expired snacks clean up their transformation and footprints', await page.evaluate(() => !qa.animals[0].magicEffect && !qa.state.scene.children.some(mesh => mesh.userData.magicTrail)));
            await page.locator('#btn-add').click();
            check('The block toolbar button returns directly to building', await page.evaluate(() => qa.state.currentMode === 'add' && !document.getElementById('btn-food').classList.contains('active')));
            await page.evaluate(() => { qa.spawnDog('quad'); qa.applySnack(qa.animals[0], ['rainbow']); qa.state.gameSpeed = 3; });
            await page.locator('#btn-explode').click();
            await page.waitForFunction(() => document.getElementById('countdown-overlay').style.display === 'none' && qa.animals.length === 0, null, { polling: 50 });
            check('The bomb clears the block friend and ordinary animals', await page.evaluate(() => qa.animals.length === 0 && qa.objects.length === 1 && !qa.state.scene.children.some(mesh => mesh.userData.magicTrail)));
            await page.waitForFunction(() => qa.explodingBricks.length === 0, null, { polling: 50 });
            check('All flying fragments disappear after the effect', await page.evaluate(() => !qa.state.scene.children.some(mesh => mesh.name === 'exploding-animal' || mesh.name === 'exploding-living-voxel')));
            await page.evaluate(() => { qa.state.gameSpeed = 1; }); await page.locator('#btn-restore').click();
            check('Restore recreates one living friend without duplicate blocks', await page.evaluate(() => qa.animals.length === 1 && Boolean(qa.animals[0].livingId) && qa.objects.length === 1));
            check('No desktop runtime exceptions', errors.length === 0, errors); await page.close();
        }
        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const mobileErrors = [];
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await preparePage(mobile); await initializeQA(mobile, url); await createBuildFixture(mobile);
        await mobile.locator('#btn-eyes').tap(); await mobile.locator('#btn-eyes').tap();
        assert.equal((await readToolbar(mobile)).mode, 'eyes');
        const mobileHead = await headPoint(mobile); await mobile.touchscreen.tap(mobileHead.x, mobileHead.y);
        check('Mobile toolbar eyes immediately awaken the six-block friend', await mobile.evaluate(() => qa.animals.length === 1 && qa.objects.length === 1));
        await mobile.locator('#btn-food').tap(); assertRecipe(await readToolbar(mobile), 1);
        const mobileFeed = await friendPoint(mobile); await mobile.touchscreen.tap(mobileFeed.x, mobileFeed.y);
        check('Mobile toolbar snack directly feeds the visible friend', await mobile.evaluate(() => qa.animals[0].magicEffect?.ingredients[0] === 'balloon' && qa.foods.length === 0));
        await mobile.screenshot({ path: '.tmp/qa/toys-mobile.png' });
        for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
            await mobile.setViewportSize(viewport);
            const untouched = await sceneCounts(mobile), selectedBefore = await readToolbar(mobile);
            let recipeIndex = recipes.findIndex(recipe => JSON.stringify(recipe.ids) === JSON.stringify(selectedBefore.recipe));
            assert.notEqual(recipeIndex, -1);
            await mobile.locator('#btn-eyes').tap(); await mobile.locator('#btn-eyes').tap();
            const eyes = await readToolbar(mobile);
            assert.equal(eyes.mode, 'eyes'); assert.equal(eyes.eyesPressed, 'true'); assert.equal(eyes.foodPressed, 'false');
            assert.equal(eyes.icon, selectedBefore.icon); assert.deepEqual(eyes.active, ['btn-eyes']);
            for (let tap = 0; tap < 12; tap++) {
                await mobile.locator('#btn-food').tap(); recipeIndex = (recipeIndex + 1) % recipes.length;
                assertRecipe(await readToolbar(mobile), recipeIndex);
                assert.deepEqual(await sceneCounts(mobile), untouched, 'toolbar touches must never create a block or dropped snack');
            }
            check(`Twelve consecutive taps advance one snack each at ${viewport.width}x${viewport.height}`, true);
            await mobile.locator('#btn-food').focus();
            for (const key of ['Enter', 'Space']) {
                await mobile.keyboard.press(key); recipeIndex = (recipeIndex + 1) % recipes.length;
                assertRecipe(await readToolbar(mobile), recipeIndex);
            }
            await mobile.locator('#btn-eyes').focus();
            for (const key of ['Enter', 'Space']) {
                await mobile.keyboard.press(key); const current = await readToolbar(mobile);
                assert.equal(current.mode, 'eyes'); assert.equal(current.eyesPressed, 'true'); assert.deepEqual(current.recipe, recipes[recipeIndex].ids);
            }
            assert.deepEqual(await sceneCounts(mobile), untouched);
            check(`Enter and Space activate each toolbar action once at ${viewport.width}x${viewport.height}`, true);
            const layout = await mobile.evaluate(() => {
                const targets = [...document.querySelectorAll('#edit-mode-panel .mode-btn, #mobile-palette-toggle')].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
                const buttons = targets.map(button => {
                    const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    const toolbar = button.closest('#edit-mode-panel')?.getBoundingClientRect();
                    const unclipped = !toolbar || (r.left >= toolbar.left && r.right <= toolbar.right && r.top >= toolbar.top && r.bottom <= toolbar.bottom);
                    return { id: button.id, width: r.width, height: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, unclipped, clickable: hit === button || button.contains(hit) };
                });
                return { width: innerWidth, height: innerHeight, buttons, overflow: document.documentElement.scrollWidth > innerWidth, centerClear: document.elementFromPoint(innerWidth * 0.46, innerHeight * 0.46)?.tagName === 'CANVAS' };
            });
            const fits = layout.width === viewport.width && Math.abs(layout.height - viewport.height) <= 1 && !layout.overflow && layout.centerClear && layout.buttons.length >= 2 && layout.buttons.every(button => button.inside && button.unclipped && button.clickable && button.width >= 40 && button.height >= 40);
            check(`Toolbar targets fit and leave the game center playable at ${viewport.width}x${viewport.height}`, fits, fits ? { width: layout.width, height: layout.height, targets: layout.buttons.length } : layout);
            await mobile.screenshot({ path: `.tmp/qa/toys-mobile-${viewport.width}x${viewport.height}.png` });
        }
        check('No mobile runtime exceptions', mobileErrors.length === 0, mobileErrors);
        await mobile.close(); console.log('RESULT', checks.length, 'toy checks passed');
    } catch (error) {
        for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: '.tmp/qa/toys-failure.png' }).catch(() => {});
        throw error;
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
