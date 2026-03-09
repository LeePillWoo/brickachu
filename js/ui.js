import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { state, guiParams, defaultParams, materials, presetColors, numCustomSlots } from './state.js';
import { explodeBricks, pushHistory, applyActionState } from './scene.js';
import { snapPreviewCamera } from './camera.js';
import { spawnDog, clearAllAnimals } from './entities.js';
import { clearAllFood } from './food.js';

export function setupPalette() {
    const panel = document.getElementById('palette-panel');
    state.popup = document.getElementById('palette-popup');

    const presetRow = document.createElement('div');
    presetRow.className = 'palette-row';
    const customRow = document.createElement('div');
    customRow.className = 'palette-row';

    presetColors.forEach((color, idx) => {
        const btn = document.createElement('div');
        btn.className = 'color-btn' + (idx === 0 ? ' active' : '');
        btn.style.backgroundColor = color;
        btn.setAttribute('data-slot', `preset-${idx}`);
        presetRow.appendChild(btn);
    });
    for (let i = 0; i < numCustomSlots; i++) {
        const btn = document.createElement('div');
        btn.className = 'color-btn custom-slot';
        btn.style.backgroundColor = '#FFFFFF';
        btn.setAttribute('data-slot', `custom-${i}`);
        customRow.appendChild(btn);
    }

    panel.appendChild(presetRow);
    panel.appendChild(customRow);

    const btns = document.querySelectorAll('.color-btn');
    btns.forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            if (e.button === 0) {
                state.popup.style.display = 'none';
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                state.currentSlot = btn.getAttribute('data-slot');
                state.rollOverMaterial.color.copy(materials[state.currentSlot].color);
                if (window.syncGUIToSlot) window.syncGUIToSlot(state.currentSlot);
            }
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            state.selectedSlotForPopup = btn.getAttribute('data-slot');
            const mat = materials[state.selectedSlotForPopup];

            state.popup.style.display = 'flex';
            let pX = e.clientX;
            let pY = e.clientY;
            if (pX + 200 > window.innerWidth) pX -= 200;
            if (pY + 150 > window.innerHeight) pY -= 150;
            state.popup.style.left = `${pX}px`;
            state.popup.style.top = `${pY}px`;

            document.getElementById('pop-color').value = '#' + mat.color.getHexString();
            document.getElementById('pop-roughness').value = mat.roughness;
        });
    });

    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('#palette-popup') && !e.target.closest('.color-btn')) {
            if (state.popup) state.popup.style.display = 'none';
        }
    });

    // Color Picker listener
    const popColor = document.getElementById('pop-color');
    if (popColor) {
        popColor.addEventListener('input', (e) => {
            if (!state.selectedSlotForPopup) return;
            const mat = materials[state.selectedSlotForPopup];
            const hex = e.target.value;
            mat.color.set(hex);
            updatePaletteIcon(state.selectedSlotForPopup, hex);
            if (state.currentSlot === state.selectedSlotForPopup) state.rollOverMaterial.color.set(hex);
        });
    }

    ['roughness'].forEach(id => {
        const el = document.getElementById(`pop-${id}`);
        if (el) {
            el.addEventListener('input', () => {
                const val = parseFloat(el.value);
                if (!state.selectedSlotForPopup) return;
                const mat = materials[state.selectedSlotForPopup];
                mat[id] = val;
            });
        }
    });
}

function updatePaletteIcon(slot, hex) {
    const btn = document.querySelector(`.color-btn[data-slot="${slot}"]`);
    if (btn) btn.style.backgroundColor = hex;
}

export function setupModeButtons() {
    const btnBlock = document.getElementById('btn-add');   // 블록 그룹 루프 버튼
    const btnExplode = document.getElementById('btn-explode');
    const btnRestore = document.getElementById('btn-restore');
    const countdownEl = document.getElementById('countdown-overlay');
    const btnAnimal = document.getElementById('add-dog-btn'); // 동물 그룹 루프 버튼
    const btnFood = document.getElementById('btn-food');       // 먹이 그룹 루프 버튼

    // ── 블록 그룹 (add ↔ remove 루프 토글) ──
    let blockState = 'add'; // 'add' | 'remove'
    let foodActive = false; // applyBlockState가 foodActive를 참조하므로 먼저 선언

    function applyBlockState(s) {
        blockState = s;
        state.currentMode = s;
        if (s === 'add') {
            btnBlock.textContent = '✏️';
            btnBlock.title = '블록 추가 (클릭 → 제거 모드)';
            btnBlock.classList.remove('remove-mode');
            btnBlock.classList.add('active');
        } else {
            btnBlock.textContent = '⬜';
            btnBlock.title = '블록 제거 (클릭 → 추가 모드)';
            btnBlock.classList.remove('active');
            btnBlock.classList.add('remove-mode');
        }
        // 먹이 모드 비활성화
        if (btnFood) {
            btnFood.classList.remove('active');
            btnFood.textContent = '🍎';
            btnFood.title = '먹이 설치 모드';
            foodActive = false;
        }
    }

    btnBlock.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (state.currentMode === 'add' || state.currentMode === 'remove') {
            applyBlockState(blockState === 'add' ? 'remove' : 'add');
        } else {
            applyBlockState('add');
        }
    });

    applyBlockState('add'); // 초기값

    // ── 동물 버튼 (단일 클릭 → 스폰) ──
    if (btnAnimal) {
        btnAnimal.addEventListener('click', (e) => {
            e.stopPropagation();
            spawnDog();
        });
    }

    // ── 먹이 버튼 (단일 클릭 → food 모드 토글) ──
    if (btnFood) {
        btnFood.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (state.currentMode !== 'food') {
                foodActive = true;
                state.currentMode = 'food';
                btnFood.classList.add('active');
                btnBlock.classList.remove('active', 'remove-mode');
            } else {
                foodActive = false;
                state.currentMode = blockState;
                btnFood.classList.remove('active');
                if (blockState === 'add') {
                    btnBlock.classList.add('active');
                } else {
                    btnBlock.classList.add('remove-mode');
                }
            }
        });
    }

    // ── 통합 지우기 버튼 (동물 + 먹이 모두 제거) ──
    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
        btnClearAll.addEventListener('click', (e) => {
            e.stopPropagation();
            clearAllAnimals();
            clearAllFood();
        });
    }

    // ── 폭발 ──
    let explosionInProgress = false;
    btnExplode.addEventListener('click', (e) => {
        e.stopPropagation();
        if (explosionInProgress) return;

        import('./scene.js').then(m => {
            state.preExplosionSnapshot = m.getFullSnapshot();
            explosionInProgress = true;

            let count = 3;
            countdownEl.innerText = count;
            countdownEl.style.display = 'block';

            const timer = setInterval(() => {
                count--;
                if (count > 0) {
                    countdownEl.innerText = count;
                } else {
                    clearInterval(timer);
                    countdownEl.style.display = 'none';
                    m.explodeBricks();
                    explosionInProgress = false;
                }
            }, 1000);
        });
    });

    // ── 복원 ──
    btnRestore.addEventListener('click', (e) => {
        e.stopPropagation();
        import('./scene.js').then(m => m.undo());
    });

    // ── 게임 속도 ──
    const btnGameSpeed = document.getElementById('btn-game-speed');
    if (btnGameSpeed) {
        const cycle = [1, 2, 3];
        const updateLabel = () => {
            const s = state.gameSpeed || 1;
            btnGameSpeed.textContent = `×${s}`;
            btnGameSpeed.title = `배속 ×${s} (클릭 시 ×1 → ×2 → ×3 순환)`;
        };
        updateLabel();
        btnGameSpeed.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = cycle.indexOf(state.gameSpeed || 1);
            state.gameSpeed = cycle[(idx + 1) % cycle.length];
            updateLabel();
        });
    }

    // ── 모바일 팔레트 ──
    const paletteToggle = document.getElementById('mobile-palette-toggle');
    const palettePanel = document.getElementById('palette-panel');
    if (paletteToggle) {
        paletteToggle.addEventListener('click', () => {
            palettePanel.classList.toggle('mobile-open');
        });
    }

    // ── 도움말 ──
    const helpBtn = document.getElementById('btn-help');
    const closeHelpBtn = document.getElementById('btn-close-help');
    const instructionsPanel = document.getElementById('instructions');

    const toggleHelp = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isVisible = instructionsPanel.style.display === 'block';
        instructionsPanel.style.display = isVisible ? 'none' : 'block';
    };

    helpBtn.addEventListener('click', toggleHelp);
    helpBtn.addEventListener('touchstart', toggleHelp, { passive: false });

    const closeHelp = (e) => {
        e.preventDefault();
        instructionsPanel.style.display = 'none';
    };
    closeHelpBtn.addEventListener('click', closeHelp);
    closeHelpBtn.addEventListener('touchstart', closeHelp, { passive: false });
}

export function setupGUI() {
    const gui = new GUI({ title: 'Settings' });
    const blockFolder = gui.addFolder('Blocks (PBR)');
    const slotOptions = {};
    presetColors.forEach((_, i) => slotOptions[`Preset ${i}`] = `preset-${i}`);
    for (let i = 0; i < numCustomSlots; i++) slotOptions[`Custom ${i}`] = `custom-${i}`;

    function updateBlockGUIOptions() {
        const mat = materials[guiParams.block.slotTarget];
        if (cCtrl) cCtrl.setValue(mat.color.getHex());
        if (rCtrl) rCtrl.setValue(mat.roughness);
    }

    const blockTargetCtrl = blockFolder.add(guiParams.block, 'slotTarget', slotOptions).name('Target Slot').onChange(updateBlockGUIOptions);
    let cCtrl = blockFolder.addColor(guiParams.block, 'color').name('Color').onChange(v => {
        materials[guiParams.block.slotTarget].color.setHex(v);
        updatePaletteIcon(guiParams.block.slotTarget, '#' + materials[guiParams.block.slotTarget].color.getHexString());
    }).onFinishChange(pushHistory);
    let rCtrl = blockFolder.add(guiParams.block, 'roughness', 0, 1).name('Roughness').onChange(v => {
        materials[guiParams.block.slotTarget].roughness = v;
    }).onFinishChange(pushHistory);

    blockFolder.add({
        reset: () => {
            Object.assign(guiParams.block, defaultParams.block);
            blockTargetCtrl.setValue(guiParams.block.slotTarget);
            updateBlockGUIOptions();
            pushHistory();
        }
    }, 'reset').name('↺ Reset Block Defaults');

    window.syncGUIToSlot = function (slot) {
        guiParams.block.slotTarget = slot;
        blockTargetCtrl.setValue(slot);
        updateBlockGUIOptions();
    };

    const boardFolder = gui.addFolder('Base Board');
    boardFolder.addColor(guiParams.board, 'color').name('Color').onChange(v => state.baseBoard.material.color.setHex(v)).onFinishChange(pushHistory);
    boardFolder.add(guiParams.board, 'roughness', 0, 1).name('Roughness').onChange(v => state.baseBoard.material.roughness = v).onFinishChange(pushHistory);
    boardFolder.add({
        reset: () => {
            Object.assign(guiParams.board, defaultParams.board);
            state.baseBoard.material.color.setHex(guiParams.board.color);
            state.baseBoard.material.roughness = guiParams.board.roughness;
            gui.controllersRecursive().forEach(c => c.updateDisplay());
            pushHistory();
        }
    }, 'reset').name('↺ Reset Board');

    const lightFolder = gui.addFolder('Lighting');
    lightFolder.add(guiParams.light, 'ambientInt', 0, 10).name('Ambient Intensity').onChange(v => state.ambientLight.intensity = v).onFinishChange(pushHistory);
    lightFolder.addColor(guiParams.light, 'color').name('Light Color').onChange(v => state.directionalLight.color.setHex(v)).onFinishChange(pushHistory);
    lightFolder.add(guiParams.light, 'intensity', 0, 10).name('Directional Intensity').onChange(v => state.directionalLight.intensity = v).onFinishChange(pushHistory);
    lightFolder.add(guiParams.light, 'x', -2000, 2000).name('Position X').onChange(v => state.directionalLight.position.x = v).onFinishChange(pushHistory);
    lightFolder.add(guiParams.light, 'y', 100, 3000).name('Position Y').onChange(v => state.directionalLight.position.y = v).onFinishChange(pushHistory);
    lightFolder.add(guiParams.light, 'z', -2000, 2000).name('Position Z').onChange(v => state.directionalLight.position.z = v).onFinishChange(pushHistory);
    lightFolder.add({
        reset: () => {
            Object.assign(guiParams.light, defaultParams.light);
            state.ambientLight.intensity = guiParams.light.ambientInt;
            state.directionalLight.color.setHex(guiParams.light.color);
            state.directionalLight.intensity = guiParams.light.intensity;
            state.directionalLight.position.set(guiParams.light.x, guiParams.light.y, guiParams.light.z);
            gui.controllersRecursive().forEach(c => c.updateDisplay());
            pushHistory();
        }
    }, 'reset').name('↺ Reset Lighting');

    const aoFolder = gui.addFolder('Ambient Occlusion');
    aoFolder.add(guiParams.ao, 'enabled').name('Enable AO').onChange(v => state.saoPass.enabled = v).onFinishChange(pushHistory);
    aoFolder.add(guiParams.ao, 'intensity', 0, 4).step(1).name('Intensity (Step)').onChange(v => {
        state.saoPass.params.saoIntensity = v * 0.00005;
    }).onFinishChange(pushHistory);
    aoFolder.add(guiParams.ao, 'radius', 0, 500).name('Radius').onChange(v => state.saoPass.params.saoRadius = v).onFinishChange(pushHistory);
    aoFolder.add(guiParams.ao, 'bias', 0, 1).name('Bias').onChange(v => state.saoPass.params.saoBias = v).onFinishChange(pushHistory);
    aoFolder.add({
        reset: () => {
            Object.assign(guiParams.ao, defaultParams.ao);
            state.saoPass.enabled = guiParams.ao.enabled;
            state.saoPass.params.saoIntensity = guiParams.ao.intensity * 0.00005;
            state.saoPass.params.saoRadius = guiParams.ao.radius;
            state.saoPass.params.saoBias = guiParams.ao.bias;
            gui.controllersRecursive().forEach(c => c.updateDisplay());
            pushHistory();
        }
    }, 'reset').name('↺ Reset AO');

    window.refreshGUI = function () {
        state.baseBoard.material.color.setHex(guiParams.board.color);
        state.baseBoard.material.roughness = guiParams.board.roughness;
        state.ambientLight.intensity = guiParams.light.ambientInt;
        state.directionalLight.color.setHex(guiParams.light.color);
        state.directionalLight.intensity = guiParams.light.intensity;
        state.directionalLight.position.set(guiParams.light.x, guiParams.light.y, guiParams.light.z);
        state.saoPass.enabled = guiParams.ao.enabled;
        state.saoPass.params.saoIntensity = guiParams.ao.intensity * 0.00005;
        state.saoPass.params.saoRadius = guiParams.ao.radius;
        state.saoPass.params.saoBias = guiParams.ao.bias;
        gui.controllersRecursive().forEach(c => c.updateDisplay());
        state.rollOverMaterial.color.copy(materials[guiParams.block.slotTarget].color);
    };

    gui.close();
}

export function setupSnapControls() {
    const snapBtns = document.querySelectorAll('.snap-btn');
    snapBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            snapBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            snapPreviewCamera(btn.dataset.dir);
        });
    });
}
