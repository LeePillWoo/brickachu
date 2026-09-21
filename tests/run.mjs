import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootURL = new URL('../', import.meta.url);
const cacheURL = new URL('.tmp/qa/', rootURL);
const suites = ['animal', 'scene', 'input', 'sound', 'food', 'living', 'magic', 'train'];

async function prepareDependencies() {
    const html = await readFile(new URL('index.html', rootURL), 'utf8');
    const importMapText = html.match(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    if (!importMapText) throw new Error('index.html의 importmap을 찾을 수 없습니다.');
    const imports = JSON.parse(importMapText).imports;
    await mkdir(cacheURL, { recursive: true });
    let previousSources = null;
    try { previousSources = JSON.parse(await readFile(new URL('dependencies.json', cacheURL), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }

    const sources = {};
    for (const [name, fileName] of [['three', 'three.mjs'], ['cannon-es', 'cannon.mjs']]) {
        const sourceURL = imports[name];
        if (typeof sourceURL !== 'string' || !sourceURL.startsWith('https://')) throw new Error(`${name}의 고정 CDN URL이 없습니다.`);
        sources[name] = sourceURL;
        const localURL = new URL(fileName, cacheURL);
        let cached = true;
        try { await access(localURL); } catch { cached = false; }
        if (cached && (!previousSources || previousSources[name] === sourceURL)) continue;

        console.log(`Downloading ${name}: ${sourceURL}`);
        const response = await fetch(sourceURL, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`${name} 다운로드 실패: HTTP ${response.status}`);
        await writeFile(localURL, await response.text(), 'utf8');
    }
    await writeFile(new URL('dependencies.json', cacheURL), JSON.stringify(sources, null, 2) + '\n', 'utf8');
}

function runSuite(name) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [
            '--import', new URL('register.mjs', import.meta.url).href,
            fileURLToPath(new URL(`${name}-test.mjs`, import.meta.url))
        ], { cwd: fileURLToPath(rootURL), stdio: 'inherit', shell: false });
        child.on('error', error => {
            console.error(`${name}: ${error.message}`);
            resolve(false);
        });
        child.on('exit', (code, signal) => {
            if (signal) console.error(`${name}: terminated by ${signal}`);
            resolve(code === 0);
        });
    });
}

try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 이상이 필요합니다.');
    await prepareDependencies();
    const failed = [];
    for (const suite of suites) {
        console.log(`\n[${suite}]`);
        if (!await runSuite(suite)) failed.push(suite);
    }
    if (failed.length) {
        console.error(`\n실패: ${failed.join(', ')}`);
        process.exitCode = 1;
    } else console.log(`\n${suites.length}개 테스트 모음 모두 통과했습니다.`);
} catch (error) {
    console.error(`테스트 실행 실패: ${error.message}`);
    process.exitCode = 1;
}
