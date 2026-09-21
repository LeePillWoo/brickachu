import { state } from './state.js';
import { SNACK_INGREDIENTS, normalizeIngredients, describeRecipe } from './magic.js';
import { onPointerCancel } from './input.js';

export function setupToyUI(chooseMode, closePanel) {
    const dock = document.getElementById('toy-dock');
    const eyesPanel = document.getElementById('eyes-panel');
    const snackPanel = document.getElementById('snack-panel');
    const ingredientList = document.getElementById('snack-ingredients');
    const notice = document.getElementById('toy-notice');
    const starter = document.getElementById('btn-toy-starter');
    const foodButton = document.getElementById('btn-food');
    const panelHeader = document.querySelector('.toy-panel-header');
    let noticeTimer = null;

    state.onToyNotice = message => {
        if (!message) return;
        clearTimeout(noticeTimer);
        notice.textContent = String(message);
        notice.classList.add('visible');
        noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3200);
    };

    document.getElementById('toy-choose-eyes').addEventListener('click', () => chooseMode('eyes'));
    document.getElementById('toy-choose-snack').addEventListener('click', () => chooseMode('food'));
    document.getElementById('toy-panel-close').addEventListener('click', () => {
        onPointerCancel();
        closePanel();
    });
    starter.addEventListener('click', () => {
        onPointerCancel();
        chooseMode('eyes');
        if (typeof state.createToyStarter === 'function') state.createToyStarter();
    });

    for (const ingredient of SNACK_INGREDIENTS) {
        const button = document.createElement('button');
        button.className = 'snack-ingredient';
        button.dataset.ingredient = ingredient.id;
        button.style.setProperty('--ingredient-color', ingredient.color);
        button.title = ingredient.description;
        button.setAttribute('aria-pressed', 'false');
        const icon = document.createElement('span');
        icon.className = 'snack-ingredient-icon';
        icon.textContent = ingredient.icon;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('strong');
        label.textContent = ingredient.label;
        button.append(icon, label);
        button.addEventListener('click', () => {
            onPointerCancel();
            // One tap chooses one snack; tapping another replaces the selection.
            state.snackIngredients = [ingredient.id];
            updateRecipe();
        });
        ingredientList.appendChild(button);
    }

    document.getElementById('snack-reset').addEventListener('click', () => {
        onPointerCancel();
        state.snackIngredients = [];
        updateRecipe();
    });

    function updateRecipe() {
        const selected = normalizeIngredients(state.snackIngredients).slice(-1);
        state.snackIngredients = selected;
        const ingredients = selected.map(id => SNACK_INGREDIENTS.find(item => item.id === id)).filter(Boolean);
        const icon = ingredients[0]?.icon || '🍎';
        const recipeName = describeRecipe(selected);
        foodButton.textContent = icon;
        foodButton.title = `간식 실험실 · ${recipeName}`;
        foodButton.setAttribute('aria-label', `간식 실험실 · ${recipeName}`);
        ingredientList.querySelectorAll('[data-ingredient]').forEach(button => {
            const active = selected.includes(button.dataset.ingredient);
            button.classList.toggle('selected', active);
            button.setAttribute('aria-pressed', String(active));
        });
        document.getElementById('snack-selection-count').textContent = '하나 선택';
        document.getElementById('snack-recipe-name').textContent = recipeName;
        document.getElementById('snack-recipe-icon').textContent = icon;
        document.getElementById('snack-recipe-description').textContent = ingredients.length
            ? ingredients.map(item => item.description).join(' · ')
            : '변신한 친구에게 주면 원래 모습으로 돌아와요.';
        document.getElementById('snack-reset').disabled = selected.length === 0;
    }

    function sync() {
        const mode = state.animalMode === 'remove' ? '' : state.currentMode;
        eyesPanel.hidden = mode !== 'eyes';
        snackPanel.hidden = mode !== 'food';
        dock.classList.toggle('toy-dock-active', mode === 'eyes' || mode === 'food');
        dock.dataset.mode = mode;
        panelHeader.hidden = mode !== 'eyes' && mode !== 'food';
        document.getElementById('toy-panel-label').textContent = mode === 'eyes' ? '👀 눈 붙이기' : '🍎 간식 하나 고르기';
        for (const [id, choiceMode] of [['btn-eyes', 'eyes'], ['btn-food', 'food']]) {
            const button = document.getElementById(id);
            button.classList.toggle('active', mode === choiceMode);
            button.setAttribute('aria-pressed', String(mode === choiceMode));
        }
        starter.hidden = typeof state.createToyStarter !== 'function';
        updateRecipe();
    }

    sync();
    return { sync };
}
