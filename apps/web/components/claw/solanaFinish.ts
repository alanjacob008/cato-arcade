import * as THREE from "three";

/** A continuous world-space finish across the cabinet's separate panels and trim. */
export function createSolanaFinish(width: number, depth: number, height: number, neon = false, tier = 2) {
  const material = new THREE.MeshPhysicalMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: neon ? 1.15 : .10,
    roughness: neon ? .12 : .19, metalness: neon ? .25 : .6, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: 1.35 });
  material.name = neon ? "Solana neon trim" : "Solana glossy enamel";
  const finishTier = { value: tier }; material.userData.finishTier = finishTier;
  const finishOffset = { value: new THREE.Vector3() }; material.userData.finishOffset = finishOffset;
  material.onBeforeCompile = shader => {
    shader.uniforms.catoFinishSize = { value: new THREE.Vector3(width, depth, height) };
    shader.uniforms.catoFinishTier = finishTier;
    shader.uniforms.catoFinishOffset = finishOffset;
    shader.uniforms.catoSilver = { value: new THREE.Color(neon ? "#d5e7ff" : "#aeb9c8") };
    shader.uniforms.catoGold = { value: new THREE.Color(neon ? "#ffcf62" : "#d6a544") };
    shader.uniforms.catoMint = { value: new THREE.Color("#14f195") };
    shader.uniforms.catoBlue = { value: new THREE.Color("#32a6ff") };
    shader.uniforms.catoPurple = { value: new THREE.Color("#9945ff") };
    shader.vertexShader = "varying vec3 vCatoFinishPosition;\n" + shader.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\nvCatoFinishPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = "varying vec3 vCatoFinishPosition;\nuniform vec3 catoFinishOffset;\nuniform float catoFinishTier;\nuniform vec3 catoSilver;\nuniform vec3 catoGold;\nuniform vec3 catoFinishSize;\nuniform vec3 catoMint;\nuniform vec3 catoBlue;\nuniform vec3 catoPurple;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
      vec3 catoLocalFinish = vCatoFinishPosition - catoFinishOffset;
      float catoT = clamp(.5 + .5 * catoLocalFinish.x / catoFinishSize.x
        - .4 * catoLocalFinish.z / catoFinishSize.y
        + .22 * (catoLocalFinish.y + 1.4) / (catoFinishSize.z + 1.9), 0.0, 1.0);
      vec3 catoTint = catoT < .5 ? mix(catoMint, catoBlue, catoT * 2.0) : mix(catoBlue, catoPurple, (catoT - .5) * 2.0);
      if (catoFinishTier < .5) catoTint = catoSilver;
      else if (catoFinishTier < 1.5) catoTint = catoGold;
      diffuseColor.rgb *= catoTint;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= catoTint;");
  };
  material.customProgramCacheKey = () => "cato-three-cabinet-finishes-v2";
  return material;
}
