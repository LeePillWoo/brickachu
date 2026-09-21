import { registerHooks } from 'node:module';

// 브라우저 importmap의 CDN 의존성을 같은 버전의 로컬 캐시로 연결한다.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'three') return { url: new URL('../.tmp/qa/three.mjs', import.meta.url).href, shortCircuit: true };
        if (specifier === 'cannon-es') return { url: new URL('../.tmp/qa/cannon.mjs', import.meta.url).href, shortCircuit: true };
        return nextResolve(specifier, context);
    }
});

globalThis.window ??= {};
globalThis.document ??= {
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
};
globalThis.requestAnimationFrame ??= () => 0;
