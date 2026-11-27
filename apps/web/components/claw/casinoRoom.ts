import * as THREE from "three";
import { MACHINE } from "./config";
import { STATION_X } from "./arcadeLayout";
import { frameTopAtDepth } from "./cameraFraming";
import { createNeonSigns, NEON_SIGN_HEIGHT, NEON_SIGN_TUBES, NEON_SIGN_WIDTH } from "./neonSign";

// Cabinet rear frame is 0.20 behind the glass. Leave only 0.15 clearance.
export const REAR_WALL_FRONT_Z = -MACHINE.depth / 2 - .20 - .15;
/** Production wall: black wood slats, levels stretched to full range for precision, darkened in the shader. */
export const WALL_TEXTURE_URL = "/claw/scene/wall-slats.jpg";
/** Linear scale that returns the stretched texture to its original near-black brightness. */
export const WALL_TEXTURE_LEVEL = 1 / 120;
/** Each station's sign hangs on the wall, centred over its machine. */
export const NEON_SIGN_Z = REAR_WALL_FRONT_Z + .07;
/** Centre height where the station framing shows the whole sign between the canopy and the frame's top edge. */
export const NEON_SIGN_Y = MACHINE.height + 1.60;
export { NEON_SIGN_HEIGHT, NEON_SIGN_TUBES, NEON_SIGN_WIDTH };
/** Fixed to the wall: fully visible in standby, allowed to crop in the close playing view. */
export function stationSignY(_framing: THREE.Camera, _width: number, _height: number) {
  return NEON_SIGN_Y;
}
const POOL_COLOR = new THREE.Color("#ff9a3c"), SIGN_LIGHT = new THREE.Color("#ff8a26"), HAZE_COLOR = new THREE.Color("#ffb45e");

/** Night-shift arcade room: black wood-slat wall lit by warm pools, haze cones and a CATO ARCADE neon over every machine. */
export function createCasinoRoom(scene: THREE.Scene, stations: readonly number[] = STATION_X) {
  const room = new THREE.Group(); room.name = "CATO Casino Club lounge"; scene.add(room);
  // A bright studio environment must not turn the black backdrop into a white softbox.
  const material = new THREE.MeshPhysicalMaterial({ color: "#000000", roughness: .9, metalness: 0,
    envMapIntensity: 0, specularIntensity: 0, clearcoat: 0 });
  material.name = "Black wood-slat arcade wall";
  // Keep the wall/floor junction, extending beyond either end of every camera pan.
  const wall = new THREE.Mesh(new THREE.BoxGeometry(400, 200, .45), material);
  wall.name = "Plain rear wall"; wall.position.set(0, 98.25, REAR_WALL_FRONT_Z - .225);
  wall.receiveShadow = true; room.add(wall);
  const signLight = { value: stations.map(() => 0) }, signY = { value: NEON_SIGN_Y };
  // Lights barely reach the wall, so it is self-lit: the slat texture times warm pools behind each station.
  // Until the slats arrive only the warm pools show (the additive term below), never a flat grey wall.
  material.emissive.set("#000000"); material.emissiveIntensity = 1;
  material.onBeforeCompile = shader => {
    shader.uniforms.catoPoolColor = { value: POOL_COLOR };
    shader.uniforms.catoSignColor = { value: SIGN_LIGHT };
    shader.uniforms.catoSignLight = signLight;
    shader.uniforms.catoSignY = signY;
    shader.vertexShader = "varying vec3 catoWallPosition;\n" + shader.vertexShader.replace("#include <worldpos_vertex>",
      "#include <worldpos_vertex>\ncatoWallPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    const pools = stations.map(x => `catoStationPool(catoWallPosition.xy, ${x.toFixed(3)})`).join(" + ");
    // One lobe of neon light round each station's sign, each following its own power-on.
    const lobe = `vec2(${(NEON_SIGN_WIDTH * .64).toFixed(3)}, ${(NEON_SIGN_HEIGHT * 1.15).toFixed(3)})`;
    const lobes = stations.map((x, i) => `catoGauss(catoWallPosition.xy, vec2(${x.toFixed(3)}, catoSignY), ${lobe}) * catoSignLight[${i}]`).join(" + ");
    shader.fragmentShader = `varying vec3 catoWallPosition;
uniform vec3 catoPoolColor; uniform vec3 catoSignColor; uniform float catoSignLight[${stations.length}]; uniform float catoSignY;
float catoGauss(vec2 p, vec2 c, vec2 s) { vec2 d = (p - c) / s; return exp(-dot(d, d)); }
float catoStationPool(vec2 p, float x) {
  // A halo round the machine plus the scallop a ceiling downlight throws on the slats.
  float halo = catoGauss(p, vec2(x, ${(MACHINE.height * .62).toFixed(3)}), vec2(2.5, 2.9));
  float drop = ${(MACHINE.height + 10).toFixed(3)} - p.y;
  float spread = .55 + max(drop, 0.0) * .42;
  float scallop = exp(-pow((p.x - x) / spread, 2.0)) * smoothstep(0.0, 1.4, drop) * exp(-max(drop, 0.0) * .30);
  return halo * .8 + scallop * 1.1;
}
` + shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
      float catoPool = ${pools};
      float catoSign = ${lobes};
      vec3 catoLight = vec3(1.0) + catoPoolColor * catoPool * 13.0 + catoSignColor * catoSign * 22.0;
      totalEmissiveRadiance = totalEmissiveRadiance * ${WALL_TEXTURE_LEVEL.toFixed(6)} * catoLight
        + (catoPoolColor * catoPool * .002 + catoSignColor * catoSign * .004);`);
  };
  material.customProgramCacheKey = () => `cato-slat-wall-v2-${stations.join(",")}`;
  const { texture, loaded: wallLoaded } = wallTexture(material);
  const signs = createNeonSigns(stations);
  for (const sign of signs.signs) { sign.group.position.y = NEON_SIGN_Y; sign.group.position.z = NEON_SIGN_Z; room.add(sign.group); }
  const haze = stations.map(x => createHazeCone(x)); room.add(...haze);
  addBackdropPreview(room);
  return Object.assign(room, {
    signs: signs.signs, texture,
    /** Settles when the wall's slat texture has arrived (or failed). Its arrival switches the wall to another shader
     * program, so the start-up warm-up waits for it rather than let that program link during the fly-in. */
    wallLoaded,
    /** Light the signs one after another, from the player's station (`fromX`) down the row; reduced motion lights all at once. */
    powerOn(now: number, reducedMotion: boolean, fromX = stations[0] ?? 0) { signs.powerOn(now, reducedMotion, fromX); },
    update(now: number, reducedMotion: boolean) {
      signs.update(now, reducedMotion);
      signs.signs.forEach((sign, i) => { signLight.value[i] = sign.level; });
    },
    /** Before the startup render: draw the dark signs' lit layers once, so lighting them later never stalls a frame. */
    primeSigns() { signs.prime(); },
    /** Small screens lift the signs clear of the station framing instead of showing them cut. */
    setSignHeight(y: number) {
      signY.value = y; for (const sign of signs.signs) sign.group.position.y = y;
    },
    /** Looking straight down the cones would fog the pile, so the haze only shows from the front. */
    setTopView(top: boolean) { haze.forEach(cone => { cone.visible = !top; }); },
  });
}

/** Production uses the black slats. Local dev keeps `?wall=1..6` to compare the other candidates. */
function wallTexture(material: THREE.MeshPhysicalMaterial) {
  let url = WALL_TEXTURE_URL, level = 1;
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    const choice = new URLSearchParams(window.location.search).get("wall");
    // The raw candidates are not level-stretched, so undo the production darkening for them.
    if (choice && /^[1-6]$/.test(choice)) { url = `/claw/backdrop-preview/wall-${choice}.jpg`; level = 1 / WALL_TEXTURE_LEVEL; }
  }
  if (typeof window === "undefined" || typeof document === "undefined" || typeof (globalThis as { Image?: unknown }).Image !== "function") return { texture: null, loaded: Promise.resolve() };
  let settle = () => {};
  const loaded = new Promise<void>(resolve => { settle = resolve; });
  const texture = new THREE.TextureLoader().load(url, () => { material.emissiveMap = texture; material.emissive.set("#ffffff"); material.needsUpdate = true; settle(); }, undefined, () => settle());
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // One tile every 2.5 world units across the 400 x 200 wall; the cabinet is 3 units wide.
  texture.repeat.set(400 / 2.5, 200 / 2.5); texture.anisotropy = 8;
  material.emissiveIntensity = level;
  return { texture, loaded };
}

/** Soft additive cone of light from a fixture above each machine; no post-processing. */
function createHazeCone(x: number) {
  const top = MACHINE.height + 12, bottom = -1.6, height = top - bottom;
  const geometry = new THREE.CylinderGeometry(.32, 2.55, height, 48, 1, true);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false, toneMapped: false,
    uniforms: { catoHaze: { value: HAZE_COLOR }, catoStrength: { value: .10 } },
    vertexShader: `varying float vHeight; varying float vFacing;
      void main() {
        vHeight = uv.y;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vec3 normalView = normalize(normalMatrix * normal);
        vFacing = abs(dot(normalView, normalize(-view.xyz)));
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `uniform vec3 catoHaze; uniform float catoStrength; varying float vHeight; varying float vFacing;
      void main() {
        // Densest under the fixture, thinning toward the floor; soft at the silhouette edges.
        float along = smoothstep(0.0, .55, vHeight) * (1.0 - smoothstep(.93, 1.0, vHeight));
        float edge = pow(vFacing, 2.2);
        gl_FragColor = vec4(catoHaze * catoStrength * along * along * edge, 1.0);
      }`,
  });
  const cone = new THREE.Mesh(geometry, material);
  cone.name = "Station haze cone"; cone.position.set(x, bottom + height / 2, .15); cone.renderOrder = 3;
  cone.castShadow = cone.receiveShadow = false; cone.frustumCulled = true;
  return cone;
}

/** Local-only design preview: `?backdrop=1..6` paints a candidate image on the rear wall. Never runs in production. */
function addBackdropPreview(room: THREE.Group) {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined" || typeof window.location === "undefined") return;
  const choice = new URLSearchParams(window.location.search).get("backdrop");
  if (!choice || !/^[1-6]$/.test(choice)) return;
  const texture = new THREE.TextureLoader().load(`/claw/backdrop-preview/backdrop-${choice}.jpg`);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Cover the full row and the camera's background at either outer station.
  const width = (STATION_X[2] - STATION_X[0]) * 2, height = width * 9 / 16;
  const mural = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(.72, .72, .72), fog: false, toneMapped: false }));
  mural.name = "Backdrop preview"; mural.position.set(0, height / 2 - .2, REAR_WALL_FRONT_Z + .005);
  room.add(mural);
}
