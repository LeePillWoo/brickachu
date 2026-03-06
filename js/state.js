import * as THREE from 'three';

export const voxelSize = 50;
export const objects = [];
export const materials = {};
export const explodingBricks = [];
export const numCustomSlots = 10;
export const presetColors = [
    '#FFFFFF', '#E0E0E0', '#BDBDBD', '#9E9E9E', '#757575', '#616161', '#424242', '#212121',
    '#F44336', '#E91E63', '#9C27B0', '#673AB7', '#3F51B5', '#2196F3', '#03A9F4', '#00BCD4',
    '#009688', '#4CAF50', '#8BC34A', '#CDDC39', '#FFEB3B', '#FFC107', '#FF9800', '#FF5722',
    '#795548', '#9E9E9E', '#607D8B', '#000000', '#B71C1C', '#880E4F', '#4A148C', '#311B92',
    '#1A237E', '#0D47A1', '#01579B', '#006064', '#004D40', '#1B5E20', '#33691E', '#827717',
    '#F57F17', '#FF6F00', '#E65100', '#BF360C', '#3E2723', '#263238', '#FF8A80', '#FF80AB',
    '#EA80FC', '#B388FF', '#8C9EFF', '#82B1FF', '#80D8FF', '#84FFFF', '#A7FFEB', '#B9F6CA',
    '#CCFF90', '#F4FF81', '#FFFF8D', '#FFE57F', '#FFD180', '#FF9E80', '#D7CCC8', '#CFD8DC'
];

export const guiParams = {
    block: { slotTarget: 'preset-0', color: 0xffffff, roughness: 0.2 },
    board: { color: 0xd6d6d6, roughness: 1.0 },
    light: { intensity: 3, color: 0xffffff, x: 500, y: 1500, z: 750, ambientInt: 5.0 },
    ao: { enabled: true, intensity: 2, radius: 250, bias: 0.5 }
};

export const defaultParams = JSON.parse(JSON.stringify(guiParams));

export const state = {
    camera: null,
    scene: null,
    renderer: null,
    plane: null,
    pointer: new THREE.Vector2(),
    raycaster: new THREE.Raycaster(),
    rollOverMesh: null,
    rollOverMaterial: null,
    targetGuideOpacity: 0,
    cubeGeo: new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize),
    controls: null,
    ambientLight: null,
    directionalLight: null,
    baseBoard: null,
    composer: null,
    saoPass: null,
    popup: null,
    selectedSlotForPopup: null,
    previewCamera: null,
    previewRenderer: null,
    previewScene: null,
    previewObjects: [],
    groundMaterial: null,   // CANNON 물리 재질: 바닥 & 블록 공용
    animalMaterial: null,   // CANNON 물리 재질: 동물 전용
    actionHistory: [],
    actionRedoStack: [],
    isRestoringHistory: false,
    preExplosionSnapshot: null,
    isDraggingBuild: false,
    isDraggingRemove: false,
    dragStartPos: new THREE.Vector3(),
    verticalBuildOffset: 0,
    previewGroup: new THREE.Group(),
    previewMaterial: new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.5, transparent: true }),
    currentColor: '#FCDb00',
    isAddMode: true,
    currentSlot: 'preset-0',
    keys: { w: false, a: false, s: false, d: false, q: false, e: false },
    velocity: new THREE.Vector3(),
    downPointerPos: new THREE.Vector2(),
    pointerDownTime: 0,
    world: null,
    /** 게임 배속 (1, 2, 3). 물리·동물 이동·애니메이션에 즉시 반영 */
    gameSpeed: 1
};
