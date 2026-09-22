import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Broad toy faces with smooth edges, including thin face/belly patches.
export function createSoftBoxGeometry(width, height, depth, corner = 1) {
    const radius = Math.min(corner, width / 2, height / 2);
    const roundedDepth = Math.max(depth, radius * 2);
    const segments = Math.min(width, height) >= 24 ? 2 : 1;
    return new RoundedBoxGeometry(width, height, roundedDepth, segments, radius).scale(1, 1, depth / roundedDepth);
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
