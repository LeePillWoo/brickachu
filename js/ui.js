import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { state, guiParams, defaultParams, materials, presetColors, numCustomSlots } from './state.js';
import { explodeBricks, pushHistory, applyActionState } from './scene.js';
import { snapPreviewCamera } from './camera.js';
import { spawnDog, clearAllAnimals, removeAllAnimalsWithEffect } from './entities.js';
import { clearAllFood, clearAllFoodWithEffect } from './food.js';

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
        deactivateClearMode();
        if (state.currentMode === 'add' || state.currentMode === 'remove') {
            applyBlockState(blockState === 'add' ? 'remove' : 'add');
        } else {
            applyBlockState('add');
        }
    });

    applyBlockState('add'); // 초기값

    // ── 동물 버튼: 단일 탭 → 스폰, 0.5초 꾹 → 타입 선택 슬라이드 메뉴 ──
    const ANIMAL_GROUPS = [
        { id: 'all',     icon: '🐾', label: '전체' },
        { id: 'quad',    icon: '🐶', label: '네발' },
        { id: 'hop',     icon: '🐰', label: '깡충' },
        { id: 'sneak',   icon: '🐌', label: '벽타기' },
        { id: 'heavy',   icon: '🐘', label: '육중' },
        { id: 'waddle',  icon: '🐧', label: '뒤뚱' },
        { id: 'sliding', icon: '🐍', label: '슬라이딩' },
        { id: 'special', icon: '✨', label: '특수' },
    ];

    let selectedAnimalGroup = 'all';
    let _animalLongPressTimer = null;
    let _animalLongPressFired = false;
    let _animalMenuOpen = false;

    // 메뉴 DOM 생성
    const animalTypeMenu = document.createElement('div');
    animalTypeMenu.id = 'animal-type-menu';
    ANIMAL_GROUPS.forEach(g => {
        const item = document.createElement('div');
        item.className = 'atm-item' + (g.id === 'all' ? ' atm-selected' : '');
        item.dataset.group = g.id;
        item.innerHTML = `<span class="atm-icon">${g.icon}</span><span class="atm-label">${g.label}</span>`;
        item.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            selectAnimalGroup(g.id);
            closeAnimalMenu();
        });
        animalTypeMenu.appendChild(item);
    });
    document.getElementById('ui-layer').appendChild(animalTypeMenu);

    function selectAnimalGroup(groupId) {
        selectedAnimalGroup = groupId;
        const g = ANIMAL_GROUPS.find(x => x.id === groupId);
        if (g && btnAnimal) {
            btnAnimal.textContent = g.icon;
            btnAnimal.title = `동물 소환 [${g.label}] (꾹 누르면 타입 선택)`;
        }
        animalTypeMenu.querySelectorAll('.atm-item').forEach(el => {
            el.classList.toggle('atm-selected', el.dataset.group === groupId);
        });
    }

    function openAnimalMenu() {
        _animalMenuOpen = true;
        const rect = btnAnimal.getBoundingClientRect();
        animalTypeMenu.style.display = 'flex';
        // 버튼 왼쪽에 메뉴 표시 (버튼 그룹이 우측에 있으므로)
        animalTypeMenu.style.top = `${rect.top}px`;
        animalTypeMenu.style.left = `${rect.left - 148}px`;
        requestAnimationFrame(() => animalTypeMenu.classList.add('atm-visible'));
    }

    function closeAnimalMenu() {
        _animalMenuOpen = false;
        animalTypeMenu.classList.remove('atm-visible');
        setTimeout(() => { if (!_animalMenuOpen) animalTypeMenu.style.display = 'none'; }, 200);
    }

    if (btnAnimal) {
        btnAnimal.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            _animalLongPressFired = false;
            btnAnimal.setPointerCapture(e.pointerId);
            _animalLongPressTimer = setTimeout(() => {
                _animalLongPressFired = true;
                openAnimalMenu();
            }, 500);
        });

        btnAnimal.addEventListener('pointermove', (e) => {
            if (!_animalMenuOpen) return;
            animalTypeMenu.querySelectorAll('.atm-item').forEach(item => {
                const r = item.getBoundingClientRect();
                const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
                item.classList.toggle('atm-hover', over);
            });
        });

        btnAnimal.addEventListener('pointerup', (e) => {
            if (_animalLongPressTimer) { clearTimeout(_animalLongPressTimer); _animalLongPressTimer = null; }
            if (_animalMenuOpen) {
                // 드래그 후 메뉴 아이템 위에서 놓으면 해당 타입 선택
                animalTypeMenu.querySelectorAll('.atm-item').forEach(item => {
                    const r = item.getBoundingClientRect();
                    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                        selectAnimalGroup(item.dataset.group);
                    }
                    item.classList.remove('atm-hover');
                });
                closeAnimalMenu();
                return;
            }
            if (_animalLongPressFired) return;
            if (e.button === 0) spawnDog(selectedAnimalGroup);
        });

        // 메뉴 외부 클릭 시 닫기
        document.addEventListener('pointerdown', (e) => {
            if (_animalMenuOpen && !e.target.closest('#animal-type-menu') && e.target !== btnAnimal) {
                closeAnimalMenu();
            }
        }, true);

        selectAnimalGroup('all'); // 초기 아이콘 및 타이틀 설정
    }

    // ── 먹이 버튼 (단일 클릭 → food 모드 토글) ──
    if (btnFood) {
        btnFood.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            deactivateClearMode();
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

    // ── 통합 제거 버튼 (클릭 → 제거 모드 토글 / 2초 누름 → 전체 삭제) ──
    const btnClearAll = document.getElementById('btn-clear-all');
    let _clearLongPressTimer = null;
    let _clearLongPressFired = false;

    // 제거 모드 해제 (다른 버튼 활성화 시 호출)
    function deactivateClearMode() {
        if (state.animalMode !== 'remove') return;
        state.animalMode = 'spawn';
        if (_clearLongPressTimer) { clearTimeout(_clearLongPressTimer); _clearLongPressTimer = null; }
        if (btnClearAll) {
            btnClearAll.classList.remove('remove-mode', 'longpress-active');
            btnClearAll.title = '동물/먹이 개별 제거 (2초 누름: 전체 삭제)';
        }
    }

    function applyClearMode(active) {
        state.animalMode = active ? 'remove' : 'spawn';
        if (active) {
            btnClearAll.classList.add('remove-mode');
            btnClearAll.title = '제거 모드 활성 | 동물/먹이 클릭으로 개별 제거 | 2초 누름 → 전체 삭제';
            // 먹이 모드 비활성화
            if (btnFood) {
                btnFood.classList.remove('active');
                btnFood.textContent = '🍎';
                btnFood.title = '먹이 설치 모드';
                foodActive = false;
            }
            // 블록 버튼 시각적 비활성화 (blockState는 유지, currentMode는 복원)
            state.currentMode = blockState;
            btnBlock.classList.remove('active', 'remove-mode');
        } else {
            btnClearAll.classList.remove('remove-mode', 'longpress-active');
            btnClearAll.title = '동물/먹이 개별 제거 (2초 누름: 전체 삭제)';
            // 블록 버튼 상태 복원
            if (blockState === 'add') {
                btnBlock.classList.add('active');
                btnBlock.classList.remove('remove-mode');
            } else {
                btnBlock.classList.add('remove-mode');
                btnBlock.classList.remove('active');
            }
        }
    }

    function showClearFlash() {
        const prev = document.getElementById('animal-clear-toast');
        if (prev) prev.remove();
        const toast = document.createElement('div');
        toast.id = 'animal-clear-toast';
        toast.innerHTML = '<span>🧹 전체 삭제 완료!</span>';
        document.getElementById('ui-layer').appendChild(toast);
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 1500);
    }

    if (btnClearAll) {
        btnClearAll.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            _clearLongPressFired = false;
            if (e.button !== 0) return;

            btnClearAll.setPointerCapture(e.pointerId); // 버튼 밖으로 나가도 pointerup 수신
            btnClearAll.classList.add('longpress-active');
            _clearLongPressTimer = setTimeout(() => {
                _clearLongPressFired = true;
                btnClearAll.classList.remove('longpress-active');
                removeAllAnimalsWithEffect();
                clearAllFoodWithEffect();
                applyClearMode(false);
                showClearFlash();
            }, 2000);
        });

        btnClearAll.addEventListener('pointerup', (e) => {
            if (_clearLongPressTimer) { clearTimeout(_clearLongPressTimer); _clearLongPressTimer = null; }
            btnClearAll.classList.remove('longpress-active');
            if (_clearLongPressFired) return;

            if (e.button === 0) {
                applyClearMode(state.animalMode !== 'remove');
            }
        });

        btnClearAll.addEventListener('pointerleave', () => {
            // 타이머는 취소하지 않음 — 2초 홀드 중 버튼 밖으로 나가도 자동 실행됨
            btnClearAll.classList.remove('longpress-active');
        });

        btnClearAll.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

        applyClearMode(false);
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
        const cycle = [1, 2, 3, 4, 5];
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
