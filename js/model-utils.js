import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Broad, flat block faces with one small step at each corner.
export function createSteppedBoxGeometry(width, height, depth, corner = 1) {
    const x = width / 2, y = height / 2;
    const c = Math.min(corner, width / 4, height / 4);
    const points = [
        [-x + c, -y], [x - c, -y], [x - c, -y + c], [x, -y + c],
        [x, y - c], [x - c, y - c], [x - c, y], [-x + c, y],
        [-x + c, y - c], [-x, y - c], [-x, -y + c], [-x + c, -y + c]
    ];
    const shape = new THREE.Shape(points.map(([px, py]) => new THREE.Vector2(px, py)));
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 }).translate(0, 0, -depth / 2);
}

// Only batch rigid parts with matching materials; animated children stay separate.
// The group owns these geometries. Call once, before assigning interaction refs.
export function mergeStaticParts(group, include = part => part.isMesh) {
    const batches = new Map();
    for (const part of group.children) {
        if (!include(part) || !part.isMesh || Array.isArray(part.material)) continue;
        if (!batches.has(part.material)) batches.set(part.material, []);
        batches.get(part.material).push(part);
    }
    const retired = new Set();
    for (const [material, parts] of batches) {
        if (parts.length < 2) continue;
        const geometries = parts.map(part => {
            part.updateMatrix();
            const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
            return geometry.applyMatrix4(part.matrix);
        });
        const geometry = mergeGeometries(geometries);
        geometries.forEach(item => item.dispose());
        if (!geometry) throw new Error('Model parts have incompatible geometry attributes');
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = parts[0].castShadow;
        mesh.receiveShadow = parts[0].receiveShadow;
        mesh.userData = { ...parts[0].userData };
        mesh.name = parts[0].name;
        parts.forEach(part => { group.remove(part); retired.add(part.geometry); });
        group.add(mesh);
    }
    // Some models share one geometry between static and moving parts.
    group.traverse(part => retired.delete(part.geometry));
    retired.forEach(geometry => geometry.dispose());
}
