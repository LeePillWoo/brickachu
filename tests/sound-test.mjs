import assert from 'node:assert/strict';

let scenario = 0;
async function loadSound(AudioContext) {
    const events = new Map();
    globalThis.window = { AudioContext };
    globalThis.document = { addEventListener(name, callback) { events.set(name, callback); } };
    const sound = await import(`../js/sound.js?test=${++scenario}`);
    return { ...sound, gesture: () => events.get('pointerdown')() };
}
const waitTurn = () => new Promise(resolve => setImmediate(resolve));
const allSounds = ['block-place', 'block-remove', 'animal-spawn', 'animal-remove', 'food-place', 'food-eat', 'food-remove', 'explode', 'animal-click-WADDLE', 'animal-click-HOP', 'animal-click-SNEAK', 'animal-click-HEAVY', 'animal-click-quadruped', 'animal-click-CARNIVORE', 'animal-click-special'];
function mockContext({ initialState = 'running', rejectResume = false } = {}) {
    const contexts = [];
    class MockParam {
        value = 1;
        setValueAtTime(value) { assert.ok(Number.isFinite(value)); this.value = value; }
        linearRampToValueAtTime(value) { assert.ok(Number.isFinite(value)); }
        exponentialRampToValueAtTime(value) { assert.ok(value > 0 && this.value > 0, 'exponential ramp must start and finish above zero'); }
    }
    class MockNode {
        connected = false;
        starts = 0;
        disconnects = 0;
        gain = new MockParam();
        frequency = new MockParam();
        Q = new MockParam();
        connect() { this.connected = true; }
        disconnect() { this.connected = false; this.disconnects++; }
        start() { this.starts++; }
        stop() {}
    }
    class MockContext {
        state = initialState;
        currentTime = 10;
        sampleRate = 8000;
        destination = {};
        nodes = [];
        resumeCalls = 0;
        denyResume = rejectResume;
        constructor() { contexts.push(this); }
        resume() {
            this.resumeCalls++;
            if (this.denyResume) return Promise.reject(new Error('NotAllowedError'));
            this.state = 'running';
            return Promise.resolve();
        }
        createNode() { const node = new MockNode(); this.nodes.push(node); return node; }
        createGain() { return this.createNode(); }
        createOscillator() { return this.createNode(); }
        createBufferSource() { return this.createNode(); }
        createBiquadFilter() { return this.createNode(); }
        createBuffer(channels, length) { return { getChannelData() { return new Float32Array(length); } }; }
    }
    return { MockContext, contexts };
}

let passed = 0;
async function check(name, fn) {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
}

await check('unsupported and denied AudioContext construction never escape gesture handlers', async () => {
    const unsupported = await loadSound(undefined);
    unsupported.gesture();
    unsupported.playSound('block-place');
    const denied = await loadSound(class { constructor() { throw new Error('SecurityError'); } });
    assert.doesNotThrow(() => denied.gesture());
    assert.doesNotThrow(() => denied.playSound('explode'));
});

await check('rejected resume is handled and a later gesture can retry', async () => {
    const { MockContext, contexts } = mockContext({ initialState: 'suspended', rejectResume: true });
    const sound = await loadSound(MockContext);
    const errors = [];
    const capture = error => errors.push(error);
    process.on('unhandledRejection', capture);
    sound.gesture();
    await waitTurn();
    assert.equal(errors.length, 0);
    const ac = contexts[0];
    assert.equal(ac.resumeCalls, 1);
    assert.ok(ac.nodes.every(node => !node.connected), 'denied unlock buffers must not remain connected');
    const pendingNodes = ac.nodes.length;
    sound.playSound('explode');
    assert.equal(ac.nodes.length, pendingNodes, 'locked contexts must not accumulate sound effects');
    ac.denyResume = false;
    sound.gesture();
    await waitTurn();
    assert.equal(ac.state, 'running');
    sound.playSound('block-place');
    assert.ok(ac.nodes.length > pendingNodes);
    process.off('unhandledRejection', capture);
});

await check('all 15 effects release every completed source, gain, and filter', async () => {
    const { MockContext, contexts } = mockContext();
    const sound = await loadSound(MockContext);
    for (const id of allSounds) sound.playSound(id);
    const ac = contexts[0];
    assert.ok(ac.nodes.length > 50);
    for (const node of ac.nodes) if (node.starts) node.onended?.();
    assert.ok(ac.nodes.every(node => !node.connected));
    assert.ok(ac.nodes.every(node => node.disconnects === 1));
});

await check('volume zero schedules no exponential ramps or audible nodes; invalid values are ignored', async () => {
    const { MockContext, contexts } = mockContext();
    const sound = await loadSound(MockContext);
    sound.setMasterVolume(0);
    for (const id of allSounds) sound.playSound(id);
    assert.equal(contexts.length, 0);
    sound.setMasterVolume(0.3);
    sound.setMasterVolume(NaN);
    sound.setMasterVolume(Infinity);
    assert.equal(sound.getMasterVolume(), 0.3);
    sound.playSound('food-eat');
    assert.equal(contexts.length, 1);
});

await check('background suspension and a closed context can recover', async () => {
    const { MockContext, contexts } = mockContext();
    const sound = await loadSound(MockContext);
    sound.gesture();
    await waitTurn();
    const first = contexts[0];
    first.state = 'suspended';
    sound.gesture();
    await waitTurn();
    assert.equal(first.resumeCalls, 2);
    first.state = 'closed';
    sound.gesture();
    await waitTurn();
    assert.equal(contexts.length, 2);
    const second = contexts[1];
    for (const node of second.nodes) if (node.starts) node.onended?.();
    assert.ok(second.nodes.every(node => !node.connected), 'unlock buffer must also disconnect');
});

console.log(`${passed} audio regression scenarios passed`);
