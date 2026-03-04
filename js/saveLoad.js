import * as THREE from 'three';
import { state, objects, materials, guiParams, explodingBricks } from './state.js';
import { placeVoxel, pushHistory, getFullSnapshot } from './scene.js';

export async function saveScene() {
    const data = objects.filter(obj => obj !== state.plane).map(obj => ({
        pos: [obj.position.x, obj.position.y, obj.position.z],
        slot: obj.userData.slot
    }));

    const matDefs = {};
    for (const [key, mat] of Object.entries(materials)) {
        matDefs[key] = {
            color: `#${mat.color.getHexString()}`,
            roughness: mat.roughness
        };
    }

    const exportObj = {
        blocks: data,
        materials: matDefs,
        lighting: {
            ambient: state.ambientLight.intensity,
            dirPosX: state.directionalLight.position.x,
            dirPosY: state.directionalLight.position.y,
            dirPosZ: state.directionalLight.position.z,
            dirInt: state.directionalLight.intensity,
            dirColor: `#${state.directionalLight.color.getHexString()}`
        },
        board: {
            color: `#${state.baseBoard.material.color.getHexString()}`,
            roughness: state.baseBoard.material.roughness
        }
    };

    const jsonString = JSON.stringify(exportObj, null, 2);
    const projectName = document.getElementById('project-name').value.trim() || 'scene';
    const fileName = `NanoBlock_${projectName.endsWith('.json') ? projectName : `${projectName}.json`}`;

    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

export function resetScene() {
    if (!confirm("Start a new screen? All current blocks will be cleared.")) return;

    const toRemove = objects.filter(obj => obj !== state.plane);
    toRemove.forEach(obj => state.scene.remove(obj));
    while (explodingBricks.length > 0) {
        state.scene.remove(explodingBricks.pop());
    }
    objects.length = 0;
    objects.push(state.plane);

    state.actionHistory = [getFullSnapshot()];
    state.actionRedoStack = [];
}

export function loadFromData(jsonString) {
    const parsed = JSON.parse(jsonString);

    const toRemove = objects.filter(obj => obj !== state.plane);
    toRemove.forEach(obj => {
        state.scene.remove(obj);
        objects.splice(objects.indexOf(obj), 1);
    });
    while (explodingBricks.length > 0) {
        state.scene.remove(explodingBricks.pop());
    }

    if (parsed.materials) {
        for (const [key, def] of Object.entries(parsed.materials)) {
            if (materials[key]) {
                materials[key].color.set(def.color);
                materials[key].roughness = def.roughness || 0.2;
                const btn = document.querySelector(`.color-btn[data-slot="${key}"]`);
                if (btn) btn.style.backgroundColor = def.color;
            }
        }
    }

    if (parsed.lighting) {
        state.ambientLight.intensity = parsed.lighting.ambient;
        state.directionalLight.position.set(parsed.lighting.dirPosX, parsed.lighting.dirPosY, parsed.lighting.dirPosZ);
        state.directionalLight.intensity = parsed.lighting.dirInt;
        state.directionalLight.color.set(parsed.lighting.dirColor);
    }

    if (parsed.board) {
        state.baseBoard.material.color.set(parsed.board.color);
        state.baseBoard.material.roughness = parsed.board.roughness || 0.4;
    }

    if (parsed.blocks) {
        parsed.blocks.forEach(item => {
            placeVoxel(new THREE.Vector3(...item.pos), item.slot, true);
        });
    }
    if (window.refreshGUI) window.refreshGUI();
}

export function loadScene(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (re) => {
        try {
            loadFromData(re.target.result);
        } catch (err) {
            console.error("Failed to load scene", err);
        }
    };
    reader.readAsText(file);
}
