// Cartoon look for the glTF: soft cel shading with a warm rim + inverted-hull outline that follows the skin.
import * as THREE from 'three';

export const OUTLINE_COLOR = '#5E2E14';
const RIM_COLOR = new THREE.Color('#FFE2B8');

let gradient: THREE.DataTexture | null = null;

/** Soft two-tone cel ramp: shadow -> lit with a narrow, anti-aliased terminator. */
export function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const t = THREE.MathUtils.smoothstep(x, 0.42, 0.56);
    const v = Math.round(255 * (0.74 + (1 - 0.74) * t));
    data.set([v, v, v, 255], i * 4);
  }
  gradient = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  gradient.minFilter = gradient.magFilter = THREE.LinearFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

/** Toon material + fresnel rim light (warm edge glow like the drawings' highlights). */
function furMaterial(map: THREE.Texture | null, color: THREE.Color, vertexColors: boolean): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ map, color, vertexColors, gradientMap: toonGradient() });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: RIM_COLOR };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;')
      .replace(
        '#include <opaque_fragment>',
        `float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
         outgoingLight += diffuseColor.rgb * uRimColor * smoothstep(0.25, 0.75, rim) * 0.35;
         #include <opaque_fragment>`,
      );
  };
  return mat;
}

/** Swap the exported PBR materials for cartoon ones, keyed by Blender material name. */
export function toonify(root: THREE.Object3D, anisotropy = 8): THREE.SkinnedMesh[] {
  const outlined: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    let mat: THREE.Material;
    switch (src.name) {
      case 'Cato_Highlight':
        mat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
        break;
      case 'Cato_Eye':
        mat = new THREE.MeshBasicMaterial({ map: src.map }); // painted iris, unlit = crisp
        break;
      case 'Cato_Detail':
        mat = new THREE.MeshBasicMaterial({ vertexColors: true }); // nose, mouth, whiskers, beans
        break;
      default: {
        // painted fur uses its texture; flat-coloured parts (e.g. the V3 plush body, tail, pads) keep their
        // base colour and, when untextured, their vertex colours
        const vertexColors = !src.map && mesh.geometry.attributes.color !== undefined;
        mat = furMaterial(src.map, src.color ?? new THREE.Color('#ffffff'), vertexColors);
        // no hull on small accessories (nose, paw pads, toe creases): it would swallow them
        const big = mesh.geometry.attributes.position.count > 1000;
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh && big) outlined.push(mesh as THREE.SkinnedMesh);
      }
    }
    const map = (mat as THREE.MeshBasicMaterial).map;
    if (map) map.anisotropy = anisotropy;
    mat.name = src.name;
    mesh.material = mat;
    mesh.frustumCulled = false; // skinned bounds don't follow animation
  });
  return outlined;
}

/** Back-face hull pushed out along skinned normals; width in world units. */
export function addOutline(mesh: THREE.SkinnedMesh, width: number): THREE.SkinnedMesh {
  const mat = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
  const uniforms = { uOutline: { value: width } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = uniforms.uOutline;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uOutline;')
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\ntransformed += normalize(objectNormal) * uOutline;');
  };
  // MeshBasicMaterial computes skinned objectNormal whenever USE_SKINNING is on
  mat.userData.uniforms = uniforms;
  const hull = new THREE.SkinnedMesh(mesh.geometry, mat);
  hull.name = `${mesh.name}_outline`;
  hull.frustumCulled = false;
  hull.bind(mesh.skeleton, mesh.bindMatrix);
  hull.renderOrder = -1;
  mesh.parent?.add(hull);
  hull.position.copy(mesh.position);
  hull.quaternion.copy(mesh.quaternion);
  hull.scale.copy(mesh.scale);
  return hull;
}

export function setOutlineWidth(hull: THREE.SkinnedMesh, width: number) {
  const u = (hull.material as THREE.Material).userData.uniforms;
  if (u) u.uOutline.value = width;
}
