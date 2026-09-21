import { state } from './state.js';
import { SNACK_INGREDIENTS, normalizeIngredients, describeRecipe } from './magic.js';

export function setupToyUI() {
    const notice = document.getElementById('toy-notice');
    const foodButton = document.getElementById('btn-food');
    const snackCycle = [null, ...SNACK_INGREDIENTS.map(ingredient => ingredient.id)];
    let noticeTimer = null;

    state.onToyNotice = message => {
        if (!message) return;
        clearTimeout(noticeTimer);
        notice.textContent = String(message);
        notice.classList.add('visible');
        noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3200);
    };

    function cycleSnack() {
        const current = normalizeIngredients(state.snackIngredients).at(-1) ?? null;
        const next = snackCycle[(snackCycle.indexOf(current) + 1) % snackCycle.length];
        state.snackIngredients = next ? [next] : [];
        return describeRecipe(state.snackIngredients);
    }

    function sync() {
        const mode = state.animalMode === 'remove' ? '' : state.currentMode;
        for (const [id, choiceMode] of [['btn-eyes', 'eyes'], ['btn-food', 'food'], ['btn-train', 'train']]) {
            const button = document.getElementById(id);
            button.classList.toggle('active', mode === choiceMode);
            button.setAttribute('aria-pressed', String(mode === choiceMode));
        }

        const selected = normalizeIngredients(state.snackIngredients).slice(-1);
        state.snackIngredients = selected;
        const ingredient = SNACK_INGREDIENTS.find(item => item.id === selected[0]);
        const recipeName = describeRecipe(selected);
        foodButton.textContent = ingredient?.icon || '🍎';
        foodButton.title = `${recipeName} · 누르면 다음 간식`;
        foodButton.setAttribute('aria-label', `${recipeName} · 누르면 다음 간식`);
    }

    sync();
    return { sync, cycleSnack };
}
