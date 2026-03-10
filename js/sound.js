/**
 * sound.js — Web Audio API 기반 절차적 효과음
 * 외부 CDN / 파일 의존성 없음, CORS 이슈 없음
 */

let _ctx = null;

function getCtx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
}

let masterVolume = 0.45;

// ── 내부 헬퍼 ──────────────────────────────────────────────

function makeGain(vol) {
    const ac = getCtx();
    const g = ac.createGain();
    g.gain.value = vol * masterVolume;
    g.connect(ac.destination);
    return g;
}

/** 오실레이터 음 재생. startFreq 지정 시 freq까지 슬라이드 */
function osc(type, freq, dur, vol = 1.0, startFreq = null) {
    const ac = getCtx();
    const g = makeGain(vol);
    const node = ac.createOscillator();
    node.type = type;
    node.frequency.setValueAtTime(startFreq ?? freq, ac.currentTime);
    if (startFreq !== null) {
        node.frequency.linearRampToValueAtTime(freq, ac.currentTime + dur * 0.75);
    }
    node.connect(g);
    g.gain.setValueAtTime(vol * masterVolume, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    node.start(ac.currentTime);
    node.stop(ac.currentTime + dur + 0.01);
}

/** 화이트 노이즈 버스트 */
function noise(dur, vol = 1.0, lpFreq = 4000) {
    const ac = getCtx();
    const bufLen = Math.ceil(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lpFreq;
    const g = makeGain(vol);
    g.gain.setValueAtTime(vol * masterVolume, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    src.connect(filter);
    filter.connect(g);
    src.start();
    src.stop(ac.currentTime + dur + 0.01);
}

// ── 효과음 정의 ────────────────────────────────────────────

const SOUNDS = {

    /** 블록 설치: 딱 하는 플라스틱 클릭 */
    'block-place': () => {
        noise(0.045, 0.28, 3500);
        osc('square', 900, 0.04, 0.12);
    },

    /** 블록 제거: 약간 낮은 탁 소리 */
    'block-remove': () => {
        noise(0.04, 0.22, 1800);
        osc('square', 550, 0.04, 0.1);
    },

    /** 동물 생성: 뿅~ 상승 팝 */
    'animal-spawn': () => {
        osc('sine', 1100, 0.18, 0.45, 440);
        osc('sine', 1650, 0.1, 0.22, 660);
    },

    /** 동물 제거: 사라지는 하강음 */
    'animal-remove': () => {
        osc('sine', 200, 0.22, 0.35, 700);
        noise(0.07, 0.12, 900);
    },

    /** 먹이 설치: 맑은 띠링 */
    'food-place': () => {
        osc('sine', 1400, 0.35, 0.35);
        osc('sine', 2100, 0.18, 0.18);
    },

    /** 동물이 먹이를 먹을 때: 사각사각 */
    'food-eat': () => {
        const ac = getCtx();
        // 짧은 고주파 노이즈 3번 반복 → 사각사각 질감
        [0, 0.07, 0.14].forEach(offset => {
            const bufLen = Math.ceil(ac.sampleRate * 0.055);
            const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
            const src = ac.createBufferSource();
            src.buffer = buf;
            const filter = ac.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 3800;
            filter.Q.value = 1.8;
            const g = ac.createGain();
            g.gain.setValueAtTime(0.28 * masterVolume, ac.currentTime + offset);
            g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + offset + 0.055);
            g.connect(ac.destination);
            src.connect(filter);
            filter.connect(g);
            src.start(ac.currentTime + offset);
            src.stop(ac.currentTime + offset + 0.06);
        });
    },

    /** 먹이 제거: 짧은 팝 */
    'food-remove': () => {
        osc('sine', 500, 0.1, 0.2, 800);
        noise(0.04, 0.1, 1200);
    },

    /** 폭탄 폭발: 펑~~~~ */
    'explode': () => {
        noise(1.0, 0.75, 320);
        osc('sawtooth', 55, 0.6, 0.55, 130);
        osc('sine', 38, 0.9, 0.75, 90);
    },

    /** 뒤뚱 (WADDLE) — 귀여운 삑 소리 */
    'animal-click-WADDLE': () => {
        osc('sine', 1600, 0.12, 0.38, 1200);
        osc('sine', 2000, 0.08, 0.1, 1600);
    },

    /** 깡충 (HOP) — 통통 튀는 스프링 소리 */
    'animal-click-HOP': () => {
        osc('sine', 900, 0.22, 0.32, 300);
        osc('triangle', 1200, 0.1, 0.18, 600);
    },

    /** 벽타기/파충류 (SNEAK) — 쉬익 하는 소리 */
    'animal-click-SNEAK': () => {
        noise(0.18, 0.22, 2200);
        osc('sawtooth', 180, 0.12, 0.15, 400);
    },

    /** 육중 (HEAVY) — 묵직한 쿵 */
    'animal-click-HEAVY': () => {
        noise(0.22, 0.45, 280);
        osc('sine', 55, 0.3, 0.45, 90);
        osc('sine', 38, 0.25, 0.55);
    },

    /** 네발 (quadruped) — 컹컹 짖는 소리 */
    'animal-click-quadruped': () => {
        osc('sawtooth', 320, 0.08, 0.35, 480);
        osc('sawtooth', 260, 0.1, 0.18, 380);
        noise(0.06, 0.18, 1800);
    },

    /** 육식동물 (CARNIVORE) — 묵직한 저음 으르렁 */
    'animal-click-CARNIVORE': () => {
        // 고주파 노이즈 제거, 극저음만 사용
        osc('sawtooth', 60, 0.55, 0.7, 110);   // 메인 으르렁 (60Hz 상승)
        osc('sine',     42, 0.5,  0.75, 75);    // 초저음 바디
        osc('triangle', 80, 0.35, 0.45, 130);   // 두께감 보강
    },

    /** 특수 (special) — 전자음 글리치 */
    'animal-click-special': () => {
        osc('square', 880, 0.06, 0.3, 440);
        osc('square', 1320, 0.05, 0.08, 660);
        osc('square', 440, 0.07, 0.12, 220);
        noise(0.04, 0.12, 5000);
    },
};

// ── 공개 API ───────────────────────────────────────────────

/**
 * 효과음 재생
 * @param {string} id  SOUNDS 키 (예: 'block-place', 'explode')
 */
export function playSound(id) {
    if (!SOUNDS[id]) return;
    try {
        SOUNDS[id]();
    } catch (_) {
        // AudioContext 미지원 환경 또는 권한 없음 → 무시
    }
}

/**
 * 마스터 볼륨 설정 (0.0 ~ 1.0)
 */
export function setMasterVolume(v) {
    masterVolume = Math.max(0, Math.min(1, v));
}

export function getMasterVolume() {
    return masterVolume;
}
