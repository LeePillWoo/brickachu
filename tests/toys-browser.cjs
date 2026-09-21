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
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader'] });
    try {
        if (!process.argv.includes('--mobile-only')) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await preparePage(page);
            await page.goto(url);
            await page.waitForFunction(async () => Boolean((await import('/js/state.js')).state.previewRenderer));
            await page.evaluate(async () => {
                window.qa = { ...await import('/js/state.js'), ...await import('/js/entities.js'), ...await import('/js/scene.js'), ...await import('/js/living.js'), ...await import('/js/magic.js'), ...await import('/js/food.js'), THREE: await import('three') };
            });
            check('Two new toys are discoverable at startup', await page.locator('#toy-choose-eyes').isVisible() && await page.locator('#toy-choose-snack').isVisible());
            await page.locator('#toy-choose-eyes').click();
            await page.locator('#btn-toy-starter').click();
            check('Starter creates six editable blocks', await page.evaluate(() => qa.objects.length === 7 && qa.state.currentMode === 'eyes'));
            const head = await page.evaluate(() => {
                const block = qa.objects.filter(o => o !== qa.state.plane).sort((a,b) => b.position.y - a.position.y)[0];
                const point = block.position.clone().add(new qa.THREE.Vector3(0,0,26)).project(qa.state.camera);
                return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
            });
            await page.mouse.move(head.x, head.y);
            const hover = await page.evaluate(p => ({ visible: qa.state.eyesPreview?.visible, count: qa.state.eyesPreview?.children.length, hit: document.elementFromPoint(p.x,p.y)?.outerHTML.slice(0,180), mode: qa.state.currentMode }), head);
            check('Eyes preview highlights the entire connected friend', hover.visible && hover.count === 6, { ...hover, head });
            await page.mouse.click(head.x, head.y);
            check('Clicking the head gives the build eyes and a physics body', await page.evaluate(() => qa.animals.length === 1 && qa.animals[0].livingEyes.children.length === 2 && qa.animals[0].body.shapes.length === 6 && qa.objects.length === 1));
            await page.keyboard.press('Control+z');
            check('Undo returns the exact six building blocks', await page.evaluate(() => qa.animals.length === 0 && qa.objects.length === 7));
            await page.keyboard.press('Control+Shift+z');
            check('Redo returns one living friend without duplicate blocks', await page.evaluate(() => qa.animals.length === 1 && qa.objects.length === 1));
            await page.screenshot({ path: '.tmp/qa/living-desktop.png' });
            await page.locator('#btn-food').click();
            await page.locator('[data-ingredient="balloon"]').click();
            await page.locator('[data-ingredient="jelly"]').click();
            await page.locator('[data-ingredient="rainbow"]').click();
            check('Choosing another snack replaces the previous selection', await page.evaluate(() => JSON.stringify(qa.state.snackIngredients) === JSON.stringify(['rainbow']) && document.querySelectorAll('.snack-ingredient.selected').length === 1 && document.querySelectorAll('.snack-ingredient[aria-pressed="true"]').length === 1));
            check('The toolbar shows the selected rainbow snack and its accessible name', await page.locator('#btn-food').evaluate(button => button.textContent === '🌈' && button.title.includes('무지개 열매') && button.getAttribute('aria-label').includes('무지개 열매')));
            await page.locator('[data-ingredient="rainbow"]').click();
            check('Tapping the selected snack again keeps that single choice', await page.evaluate(() => JSON.stringify(qa.state.snackIngredients) === JSON.stringify(['rainbow'])));
            check('Only one toolbar mode is highlighted and duplicate entry cards are hidden', await page.evaluate(() => document.querySelectorAll('#edit-mode-panel .active').length === 1 && document.querySelector('#btn-food').classList.contains('active') && getComputedStyle(document.querySelector('.toy-choices')).display === 'none'));
            await page.locator('[data-ingredient="balloon"]').click();
            const beforeFeeding = await page.evaluate(() => qa.animals[0].body.position.y);
            const feedPoint = await page.evaluate(() => {
                const point = qa.animals[0].mesh.localToWorld(new qa.THREE.Vector3(0, 85, 26)).project(qa.state.camera);
                return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
            });
            await page.mouse.click(feedPoint.x, feedPoint.y);
            check('Clicking a friend feeds exactly the selected snack', await page.evaluate(() => JSON.stringify(qa.animals[0].magicEffect?.ingredients) === JSON.stringify(['balloon']) && qa.foods.length === 0));
            await page.waitForFunction(y => qa.animals[0].body.position.y > y + 35, beforeFeeding, { polling: 50 });
            check('Balloon friend inflates and floats at no more than 40 percent of its normal speed', await page.evaluate(() => {
                const friend = qa.animals[0];
                return friend.mesh.getObjectByName('snack-balloon-shell') !== undefined && friend.mesh.scale.x > 1
                    && Math.hypot(friend.body.velocity.x, friend.body.velocity.z) <= friend.speed * 0.4 + 1e-6;
            }));
            await page.screenshot({ path: '.tmp/qa/snacks-desktop.png' });
            await page.locator('#snack-reset').click();
            check('Choosing the ordinary apple resets the toolbar icon', await page.locator('#btn-food').textContent() === '🍎');
            const floatingPoint = await page.evaluate(() => {
                const point = new qa.THREE.Box3().setFromObject(qa.animals[0].mesh).getCenter(new qa.THREE.Vector3()).project(qa.state.camera);
                return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
            });
            await page.mouse.click(floatingPoint.x, floatingPoint.y);
            check('Ordinary apple restores the original block friend', await page.evaluate(() => !qa.animals[0].magicEffect && qa.animals[0].mesh.scale.equals(qa.animals[0].baseScale)));
            await page.evaluate(() => {
                const animal = qa.animals[0];
                qa.applySnack(animal, ['rainbow']);
                animal.body.position.set(25, 75, 25);
                animal.mesh.position.set(25,0,25);
                for (let i=0; i<10; i++) { animal.body.position.x += 18; animal.mesh.position.x += 18; qa.updateMagicEffects(qa.animals, 0.13); }
            });
            check('Rainbow creates colored temporary footprints without editing blocks', await page.evaluate(() => qa.state.scene.children.filter(mesh => mesh.userData.magicTrail).length >= 5 && qa.objects.length === 1));
            await page.evaluate(() => qa.updateMagicEffects(qa.animals, 20));
            check('Snack expires and disposes trails and transformation', await page.evaluate(() => !qa.animals[0].magicEffect && !qa.state.scene.children.some(mesh => mesh.userData.magicTrail)));
            await page.locator('#toy-panel-close').click();
            check('Closing the toy panel returns to block editing with no stale snack highlight', await page.evaluate(() => qa.state.currentMode === 'add' && !document.querySelector('#btn-food').classList.contains('active') && document.querySelector('#snack-panel').hidden && document.querySelector('.toy-panel-header').hidden));
            await page.evaluate(() => { qa.spawnDog('quad'); qa.applySnack(qa.animals[0], ['rainbow']); qa.state.gameSpeed = 3; });
            await page.locator('#btn-explode').click();
            await page.waitForFunction(() => document.getElementById('countdown-overlay').style.display === 'none' && qa.animals.length === 0, null, { polling: 50 });
            check('The bomb clears both a living-only build and ordinary animals', await page.evaluate(() => qa.animals.length === 0 && qa.objects.length === 1 && !qa.state.scene.children.some(mesh => mesh.userData.magicTrail)));
            await page.waitForFunction(() => qa.explodingBricks.length === 0, null, { polling: 50 });
            check('All flying animal and living-block fragments disappear after the effect', await page.evaluate(() => !qa.state.scene.children.some(mesh => mesh.name === 'exploding-animal' || mesh.name === 'exploding-living-voxel')));
            await page.evaluate(() => { qa.state.gameSpeed = 1; });
            await page.locator('#btn-restore').click();
            check('Restore recreates one living friend without duplicate blocks', await page.evaluate(() => qa.animals.length === 1 && Boolean(qa.animals[0].livingId) && qa.objects.length === 1));
            check('No desktop runtime exceptions', errors.length === 0, errors);
            await page.close();
        }

        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const mobileErrors = [];
        mobile.on('pageerror', error => mobileErrors.push(error.message));
        await preparePage(mobile);
        await mobile.goto(url);
        await mobile.waitForFunction(async () => Boolean((await import('/js/state.js')).state.previewRenderer));
        await mobile.evaluate(async () => { window.qa = { ...await import('/js/state.js'), ...await import('/js/entities.js'), THREE: await import('three') }; });
        await mobile.locator('#toy-choose-eyes').tap();
        await mobile.locator('#btn-toy-starter').tap();
        const mobileHead = await mobile.evaluate(() => {
            const block = qa.objects.filter(o => o !== qa.state.plane).sort((a,b) => b.position.y - a.position.y)[0];
            const point = block.position.clone().add(new qa.THREE.Vector3(0,0,26)).project(qa.state.camera);
            return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
        });
        await mobile.touchscreen.tap(mobileHead.x, mobileHead.y);
        check('Mobile eye tap awakens the six-block friend', await mobile.evaluate(() => qa.animals.length === 1 && qa.objects.length === 1));
        await mobile.locator('#btn-food').tap();
        await mobile.locator('[data-ingredient="balloon"]').tap();
        const mobileLayout = await mobile.evaluate(() => {
            const panel = document.getElementById('toy-dock').getBoundingClientRect();
            return { panelTop: panel.top, panelBottom: panel.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        check('Mobile snack panel leaves the center playable without horizontal overflow', mobileLayout.panelTop >= 480 && mobileLayout.panelBottom <= 844 && !mobileLayout.overflow, mobileLayout);
        const mobileFeed = await mobile.evaluate(() => {
            const point = qa.animals[0].mesh.localToWorld(new qa.THREE.Vector3(0,85,26)).project(qa.state.camera);
            return { x: (point.x+1)*innerWidth/2, y: (1-point.y)*innerHeight/2 };
        });
        await mobile.touchscreen.tap(mobileFeed.x, mobileFeed.y);
        check('Mobile directly feeds the visible friend', await mobile.evaluate(() => qa.animals[0].magicEffect?.ingredients[0] === 'balloon'));
        await mobile.screenshot({ path: '.tmp/qa/toys-mobile.png' });
        // Exercise touch targets and panel layout across small phones, tablets,
        // and a phone rotated to landscape without reloading the application.
        for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
            await mobile.setViewportSize(viewport);
            if (await mobile.locator('#toy-panel-close').isVisible()) await mobile.locator('#toy-panel-close').tap();
            await mobile.locator('#btn-food').tap();
            for (const id of ['balloon', 'jelly', 'rainbow', 'rainbow', 'balloon']) {
                await mobile.locator(`[data-ingredient="${id}"]`).tap();
                const selection = await mobile.evaluate(() => ({
                    count: document.querySelectorAll('.snack-ingredient.selected').length,
                    recipe: qa.state.snackIngredients.join(','),
                    icon: document.querySelector('#btn-food').textContent,
                    highlighted: [...document.querySelectorAll('.snack-ingredient')].filter(button => getComputedStyle(button).backgroundColor !== 'rgb(255, 255, 255)').length,
                }));
                assert.equal(selection.count, 1);
                assert.equal(selection.recipe, id);
                assert.equal(selection.icon, { balloon: '🎈', jelly: '🍮', rainbow: '🌈' }[id]);
                assert.equal(selection.highlighted, 1, 'only one snack should look selected immediately after a tap');
            }
            const layout = await mobile.evaluate(() => {
                const targets = [...document.querySelectorAll('#edit-mode-panel .mode-btn, #snack-ingredients button, #snack-reset, #toy-panel-close, #mobile-palette-toggle')];
                const buttons = targets.map(button => {
                    const r = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    const toolbar = button.closest('#edit-mode-panel')?.getBoundingClientRect();
                    const unclipped = !toolbar || (r.left >= toolbar.left && r.right <= toolbar.right && r.top >= toolbar.top && r.bottom <= toolbar.bottom);
                    return { id: button.id || button.dataset.ingredient, width: r.width, height: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, unclipped, clickable: hit === button || button.contains(hit) };
                });
                const dock = document.getElementById('toy-dock').getBoundingClientRect();
                return { width: innerWidth, height: innerHeight, dockHeight: dock.height, buttons, overflow: document.documentElement.scrollWidth > innerWidth, centerClear: document.elementFromPoint(innerWidth * 0.46, innerHeight * 0.46)?.tagName === 'CANVAS' };
            });
            const layoutOK = layout.width === viewport.width && Math.abs(layout.height - viewport.height) <= 1 && !layout.overflow && layout.centerClear && layout.buttons.every(button => button.inside && button.unclipped && button.clickable && button.width >= 40 && button.height >= 40);
            check(`Touch controls fit and stay independently clickable at ${viewport.width}x${viewport.height}`, layoutOK, layoutOK ? { width: layout.width, height: layout.height, dockHeight: layout.dockHeight, touchTargets: layout.buttons.length } : layout);
            await mobile.screenshot({ path: `.tmp/qa/toys-mobile-${viewport.width}x${viewport.height}.png` });
            await mobile.locator('#toy-panel-close').tap();
            await mobile.locator('#btn-eyes').tap();
            assert.equal(await mobile.locator('#btn-food').textContent(), '🎈', 'the selected snack icon survives closing the panel and switching modes');
            const eyesFits = await mobile.locator('#btn-toy-starter').evaluate(button => {
                const rect = button.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= innerHeight && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            });
            check(`Eyes starter remains reachable at ${viewport.width}x${viewport.height}`, eyesFits);
        }
        check('No mobile runtime exceptions', mobileErrors.length === 0, mobileErrors);
        console.log('RESULT', checks.length, 'toy checks passed');
    } catch (error) {
        for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: '.tmp/qa/toys-failure.png' }).catch(() => {});
        throw error;
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
