/**
 * sound.js — Web Audio API 기반 절차적 효과음
 * 외부 CDN / 파일 의존성 없음, CORS 이슈 없음
 * 모바일(iOS Safari 포함) 오디오 언락 지원
 */

let _ctx = null;
let _unlocked = false;

function getCtx() {
    if (_ctx?.state === 'closed') {
        _ctx = null;
        _unlocked = false;
    }
    if (!_ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try {
            _ctx = new Ctor();
        } catch (_) {
            return null;
        }
    }
    return _ctx;
}

function disconnectWhenEnded(source, ...nodes) {
    source.onended = () => {
        source.disconnect();
        nodes.forEach(node => node.disconnect());
        source.onended = null;
    };
}

/** iOS/Android 브라우저 오디오 언락: 최초 터치 시 무음 버퍼 재생 */
function _unlockAudio() {
    if (_unlocked && _ctx?.state === 'running') return;
    const ac = getCtx();
    if (!ac) return;

    let src = null;
    const cancelUnlock = () => {
        _unlocked = false;
        if (!src) return;
        src.onended = null;
        src.disconnect();
        try { src.stop(); } catch (_) { /* start가 실패했을 수도 있다. */ }
    };
    try {
        // 무음 1샘플 버퍼 재생 → 브라우저 오디오 잠금 해제
        const buf = ac.createBuffer(1, 1, ac.sampleRate);
        src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        disconnectWhenEnded(src);
        src.start(0);

        Promise.resolve(ac.resume()).then(() => {
            _unlocked = ac.state === 'running';
        }).catch(() => {
            // 권한 거부 후에도 다음 사용자 제스처에서 다시 시도할 수 있다.
            cancelUnlock();
        });
    } catch (_) {
        cancelUnlock();
    }
}

// 모든 사용자 제스처 이벤트에 언락 훅 등록
['touchstart', 'touchend', 'pointerdown', 'click'].forEach(evt => {
    document.addEventListener(evt, _unlockAudio, { passive: true });
});

let masterVolume = 0.45;

// ── 내부 헬퍼 ──────────────────────────────────────────────

function makeGain(ac, vol) {
    const g = ac.createGain();
    g.gain.value = vol * masterVolume;
    g.connect(ac.destination);
    return g;
}

/** 오실레이터 음 재생. startFreq 지정 시 freq까지 슬라이드 */
function osc(type, freq, dur, vol = 1.0, startFreq = null) {
    const ac = getCtx();
    if (!ac || vol * masterVolume <= 0) return;
    const g = makeGain(ac, vol);
    const node = ac.createOscillator();
    node.type = type;
    node.frequency.setValueAtTime(startFreq ?? freq, ac.currentTime);
    if (startFreq !== null) {
        node.frequency.linearRampToValueAtTime(freq, ac.currentTime + dur * 0.75);
    }
    node.connect(g);
    disconnectWhenEnded(node, g);
    g.gain.setValueAtTime(vol * masterVolume, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    node.start(ac.currentTime);
    node.stop(ac.currentTime + dur + 0.01);
}

/** 화이트 노이즈 버스트 */
function noise(dur, vol = 1.0, lpFreq = 4000) {
    const ac = getCtx();
    if (!ac || vol * masterVolume <= 0) return;
    const bufLen = Math.ceil(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lpFreq;
    const g = makeGain(ac, vol);
    g.gain.setValueAtTime(vol * masterVolume, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    src.connect(filter);
    filter.connect(g);
    disconnectWhenEnded(src, filter, g);
    src.start();
    src.stop(ac.currentTime + dur + 0.01);
}

// ── 효과음 정의 ────────────────────────────────────────────

const SOUNDS = {

    /** 장난감 기관차의 부드러운 출발 기적 */
    'train-whistle': () => {
        osc('sine', 660, 0.38, 0.22, 540);
        osc('triangle', 990, 0.3, 0.08, 810);
        noise(0.18, 0.035, 1200);
    },

    /** 마법 길을 그린 뒤 반짝이는 화음 */
    'train-route': () => {
        osc('sine', 1046.5, 0.3, 0.16);
        osc('sine', 1318.5, 0.4, 0.12);
        osc('sine', 1568, 0.5, 0.08);
    },

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
            disconnectWhenEnded(src, filter, g);
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
    if (!Object.hasOwn(SOUNDS, id) || masterVolume <= 0) return;
    try {
        // 잠긴 상태에서 음을 쌓아 두면 다음 터치 때 한꺼번에 재생된다.
        const ac = getCtx();
        if (!ac || ac.state !== 'running') return;
        SOUNDS[id]();
    } catch (_) {
        // AudioContext 미지원 환경 또는 권한 없음 → 무시
    }
}

/**
 * 마스터 볼륨 설정 (0.0 ~ 1.0)
 */
export function setMasterVolume(v) {
    if (!Number.isFinite(v)) return;
    masterVolume = Math.max(0, Math.min(1, v));
}

export function getMasterVolume() {
    return masterVolume;
}
