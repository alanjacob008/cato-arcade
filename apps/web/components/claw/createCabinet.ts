import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { MACHINE, POCKET } from "./config";
import { ledMatrixTexture, pixelTexture, LED_AMBER, LED_COLUMNS, LED_ROWS } from "./machineTypography";
import { cabinetFeedback, CABINET_FEEDBACK_DURATION } from "./feedback";
import { marqueeChase } from "./marqueeChase";
import { surfaceTexture } from "./materialTextures";
import { themeAppearance, type ClubTheme } from "./clubCosmetics";
import { createSolanaFinish } from "./solanaFinish";

const AMBER = "#FEA911", EMBER = "#D3601E", LED_OFF = "#3a2a1c";
const BULB_GLASS = new THREE.Color("#6b3d0c"), BULB_HOT = new THREE.Color("#FFEDCD");
/** The key art's faint mint-teal rim. */
export const CABINET_RIM_COLOR = "#4FE3C1";

/**
 * A faint mint-teal glint along the cabinet's right-hand outer edges, where they turn away from the camera, as in the
 * key art. It is drawn on the cabinet's own surfaces: a teal lamp would also have tinted the pile and the chamber lining.
 */
function tealRim(material: THREE.MeshStandardMaterial, strength: number, offset: { value: THREE.Vector3 }, rightFrom: number, cacheKey: string) {
  const base = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    base(shader, renderer);
    shader.uniforms.catoRimColor = { value: new THREE.Color(CABINET_RIM_COLOR).multiplyScalar(strength) };
    shader.uniforms.catoRimOffset = offset;
    shader.vertexShader = "varying float vCatoRimX;\n" + shader.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\nvCatoRimX = (modelMatrix * vec4(transformed, 1.0)).x;");
    shader.fragmentShader = "uniform vec3 catoRimColor;\nuniform vec3 catoRimOffset;\nvarying float vCatoRimX;\n" + shader.fragmentShader.replace("#include <lights_fragment_begin>", `{
        // The whole rounded right-hand edge turning away from the camera, not just its outermost sliver.
        float catoGraze = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        float catoRight = smoothstep(.2, .7, normal.x) * smoothstep(${rightFrom.toFixed(3)}, ${(rightFrom + .15).toFixed(3)}, vCatoRimX - catoRimOffset.x);
        totalEmissiveRadiance += catoRimColor * pow(catoGraze, 1.3) * catoRight;
      }
      #include <lights_fragment_begin>`);
  };
  material.customProgramCacheKey = () => cacheKey;
}

/**
 * Rounded blocks by shape, kept for one machine build. A build makes three identical cabinets (the player's and its two
 * neighbours), and building a rounded box (thousands of vertices, each with its own UV) was most of the build's
 * main-thread time under the loading screen; a copy of an earlier one costs a fraction. Every mesh still gets its own
 * geometry, so disposal stays per mesh, and the shapes are dropped once the build's task is over.
 */
const roundedShapes = new Map<string, THREE.BufferGeometry>();
function roundedBox(width: number, height: number, depth: number, segments: number, radius: number) {
  const key = `${width},${height},${depth},${segments},${radius}`;
  let shape = roundedShapes.get(key);
  if (!shape) {
    if (roundedShapes.size === 0) setTimeout(() => { roundedShapes.forEach(geometry => geometry.dispose()); roundedShapes.clear(); }, 0);
    shape = new RoundedBoxGeometry(width, height, depth, segments, radius); roundedShapes.set(key, shape);
  }
  return new THREE.BufferGeometry().copy(shape);
}

export function createCabinet(scene: THREE.Scene, finishTier = 2) {
  const cabinet = new THREE.Group(); cabinet.name = "CATO arcade cabinet"; scene.add(cabinet);
  const canopy = new THREE.Group(); cabinet.add(canopy);
  const w = MACHINE.width, d = MACHINE.depth, h = MACHINE.height;
  const x = w / 2, z = d / 2;
  const purple = createSolanaFinish(w, d, h, false, finishTier);
  // Neutral, slightly warm metals: their colour comes from the warm room they reflect, not from a cold blue cast.
  const interior = new THREE.MeshStandardMaterial({ color: "#67615a", roughness: .32, metalness: .9 });
  interior.name = "Shared chamber lining";
  // Warm bronze trim in the arcade palette (was lilac); the Solana enamel itself is untouched.
  const lilac = new THREE.MeshStandardMaterial({ color: "#7a4519", roughness: .3, metalness: .75 });
  lilac.name = "Ember bronze trim";
  const dark = new THREE.MeshStandardMaterial({ color: "#221e1a", roughness: .32, metalness: .9 });
  const metal = new THREE.MeshPhysicalMaterial({ color: "#88847d", roughness: .25, metalness: 1, clearcoat: .15, clearcoatRoughness: .16, envMapIntensity: 1.3 });
  const metalGrain = surfaceTexture("metal"); metal.bumpMap = metalGrain; metal.bumpScale = .001;
  metal.name = "Brushed stainless steel cabinet hardware";
  interior.bumpMap = metalGrain; interior.bumpScale = .0007;
  purple.bumpMap = metalGrain; purple.bumpScale = .0008;
  tealRim(purple, .55, purple.userData.finishOffset, x - .1, "cato-three-cabinet-finishes-v2-teal-rim");
  tealRim(metal, .5, purple.userData.finishOffset, x - .1, "cato-cabinet-steel-teal-rim");
  // The marquee's LED board: near-black, so only the lit LEDs and their glow show.
  const board = new THREE.MeshStandardMaterial({ color: "#0c0907", roughness: .85, metalness: 0 });
  board.name = "LED marquee board";
  // Signal-red joystick ball and PLAY button: glossy arcade plastic lit from within.
  const controlPurple = new THREE.MeshPhysicalMaterial({ color: "#ED2939", emissive: "#ff1f33", emissiveIntensity: 1.1, roughness: .16, metalness: .05, clearcoat: 1, clearcoatRoughness: .05 });
  controlPurple.name = "Signal red control plastic";
  const glow = createSolanaFinish(w, d, h, true, finishTier);
  function pane(options: THREE.MeshPhysicalMaterialParameters = {}) {
    const material = new THREE.MeshPhysicalMaterial({ color: "#fcfbf8", roughness: .025, metalness: 0,
      transmission: .98, thickness: .018, ior: 1.52, clearcoat: .65, clearcoatRoughness: .025, envMapIntensity: 1.1,
      transparent: true, opacity: .75, depthWrite: false, ...options });
    // Polished flat panes should preserve scene detail. Three's default transmission sample
    // applies bicubic/mipmap blur even at its minimum physical-material roughness.
    material.onBeforeCompile = shader => {
      const transmission = THREE.ShaderChunk.transmission_pars_fragment.replace(
        "return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );",
        "return textureLod( transmissionSamplerMap, fragCoord.xy, 0.0 );",
      );
      shader.fragmentShader = shader.fragmentShader.replace("#include <transmission_pars_fragment>", transmission);
    };
    material.customProgramCacheKey = () => `cato-clear-pane-transmission-v1-${material.clearcoat > 0 ? "coat" : "bare"}`;
    return material;
  }
  const glass = pane();
  // Looking straight down, the roof pane mirrored the studio's overhead softbox as a white blob over the pile;
  // a thinner, uncoated reflection keeps the glazing readable without it.
  const roofGlass = pane({ clearcoat: 0, specularIntensity: .12 }); roofGlass.name = "Roof glass";
  let activeMessage = "CLAW MACHINE";
  let marquee: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  /** Same words and timing as before, now lit on the amber LED board (a result keeps its green or red). */
  function setMessage(message: string, color = LED_AMBER) {
    if (!marquee || (activeMessage === message && marquee.userData.color === color)) return;
    activeMessage = message; marquee.userData.color = color;
    marquee.material.map?.dispose(); marquee.material.map = ledMatrixTexture(message, color);
  }

  function block(size: [number, number, number], at: [number, number, number], material: THREE.Material, parent: THREE.Object3D = cabinet, radius = .035) {
    const mesh = new THREE.Mesh(roundedBox(...size, 4, radius), material);
    mesh.position.set(...at); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  function label(text: string, width: number, at: [number, number, number], color: string, parent: THREE.Object3D = cabinet) {
    const texture = pixelTexture(text, color);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width * texture.image.height / texture.image.width),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.position.set(...at); parent.add(mesh); return mesh;
  }

  // Hollow pedestal and split floor leave a real opening into the delivery bay.
  block([w + .25, 1.22, .12], [0, -.73, z + .065], purple);
  block([w + .25, 1.22, .12], [0, -.73, -z - .065], purple);
  for (const side of [-1, 1]) block([.12, 1.22, d + .12], [side * (x + .065), -.73, 0], purple);
  block([w + .34, .16, d + .34], [0, -1.39, 0], dark);
  function splitFloor(y: number, thickness: number, extra: number, material: THREE.Material) {
    const right = x + extra, left = -x - extra, back = -z - extra, front = z + extra;
    block([right - POCKET.maxX, thickness, front - back], [(right + POCKET.maxX) / 2, y, (front + back) / 2], material, cabinet, .01);
    block([POCKET.maxX - left, thickness, POCKET.minZ - back], [(POCKET.maxX + left) / 2, y, (POCKET.minZ + back) / 2], material, cabinet, .01);
  }
  splitFloor(-.06, .14, .12, lilac);
  splitFloor(-.005, .05, .05, dark);
  block([w + .24, h, .13], [0, h / 2, -z - .065], purple);
  block([.13, h, d + .12], [-x - .065, h / 2, 0], purple);
  // Neutral brushed-metal lining gives prizes depth behind the reflective glass.
  block([w, h - .14, .025], [0, h / 2, -z - .012], interior, cabinet, .005).name = "Rear chamber lining";
  for (const side of [-1, 1]) {
    block([.025, h - .14, d], [side * (x + .012), h / 2, 0], interior, cabinet, .005).name = side < 0 ? "Left chamber lining" : "Right chamber lining";
  }
  for (const px of [-x - .06, x + .06]) for (const pz of [-z - .06, z + .06]) {
    block([.14, h + .10, .14], [px, h / 2, pz], metal, cabinet, .025);
    if (pz > 0) block([.04, h - .10, .021], [px, h / 2, pz + .077], purple, cabinet, .005);
  }

  const frontGlass = new THREE.Mesh(new THREE.BoxGeometry(w - .08, h - .15, .025), glass);
  frontGlass.position.set(0, h / 2, z + .065); cabinet.add(frontGlass);
  const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(.025, h - .15, d - .08), glass);
  sideGlass.position.set(x + .065, h / 2, 0); cabinet.add(sideGlass);
  const topGlass = new THREE.Mesh(new THREE.BoxGeometry(w - .06, .025, d - .06), roofGlass);
  topGlass.position.set(0, h + .045, 0); cabinet.add(topGlass);
  // Subtle highlights communicate glass without washing out the prizes.
  const reflection = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: .055, depthWrite: false, side: THREE.DoubleSide });
  const frontShine = new THREE.Mesh(new THREE.PlaneGeometry(.08, 1.05), reflection);
  frontShine.position.set(-.95, h - .85, z + .069); frontShine.rotation.z = -.42; cabinet.add(frontShine);
  const sideShine = new THREE.Mesh(new THREE.PlaneGeometry(.08, .9), reflection);
  sideShine.position.set(x + .069, h - .75, .5); sideShine.rotation.set(0, Math.PI / 2, -.42); cabinet.add(sideShine);

  // Four symmetric corner tubes; the front pair clears the glass-frame posts.
  const led = new THREE.MeshBasicMaterial({ color: LED_OFF, toneMapped: false });
  const ledHalo = new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: .16, blending: THREE.AdditiveBlending, depthWrite: false });
  const diffuser = new THREE.MeshPhysicalMaterial({ color: "#fbe9d2", roughness: .25, transmission: .25, thickness: .012, transparent: true, opacity: .28, depthWrite: false });
  const tubePositions = [[-x + .06, z + .15], [x - .06, z + .15], [-x + .13, -z + .13], [x - .13, -z + .13]];
  const tubeNames = ["Front left feedback tube", "Front right feedback tube", "Rear left feedback tube", "Rear right feedback tube"];
  for (const [index, [px, pz]] of tubePositions.entries()) {
    block([.072, h - .25, .038], [px, h / 2, pz - .018], dark, cabinet, .012);
    const halo = block([.12, h - .25, .075], [px, h / 2, pz], ledHalo, cabinet, .018);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(.014, .014, h - .25, 12), led);
    tube.name = tubeNames[index];
    tube.position.set(px, h / 2, pz + .015); cabinet.add(tube);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, h - .23, 16), diffuser);
    sleeve.position.copy(tube.position); cabinet.add(sleeve);
    halo.castShadow = tube.castShadow = halo.receiveShadow = tube.receiveShadow = false;
  }
  const ceiling = block([w - .25, .025, .15], [0, h - .16, -z + .08], led, cabinet, .009); ceiling.castShadow = false;
  const ceilingFill = new THREE.PointLight("#ffac55", .55, 5.5, 2); ceilingFill.position.set(0, h - .2, 0); cabinet.add(ceilingFill);
  ceilingFill.name = "Cabinet interior fill";
  const ceilingLight = new THREE.PointLight("#ffac55", .35, 6, 2); ceilingLight.position.set(0, h - .5, 0); cabinet.add(ceilingLight);
  ceilingLight.name = "Centered chamber light";
  let powered = false, connected = false, power = 0;
  let feedback: { success: boolean; started: number } | null = null;
  function updateLighting(now: number, dt: number, reducedMotion: boolean) {
    if (feedback && now - feedback.started >= CABINET_FEEDBACK_DURATION) feedback = null;
    power = reducedMotion ? (powered || connected ? 1 : 0) : THREE.MathUtils.damp(power, powered || connected ? 1 : 0, connected ? 3 : 9, dt);
    const state = cabinetFeedback(power, feedback?.success ?? null, feedback ? now - feedback.started : 0, reducedMotion);
    const illumination = state.active ? 1 : power;
    if (state.active) setMessage(feedback!.success ? "YOU WON!" : "NEXT TIME", state.color);
    else if (!powered) setMessage(Math.floor(now / 3500) % 2 ? "INSERT TOKEN" : "CLAW MACHINE");
    // Result colours come from the shared feedback; the powered idle glow is the arcade's amber.
    const tone = state.active ? state.color : AMBER;
    led.color.set(state.active || power > .05 ? tone : LED_OFF);
    if (state.active || power > .05) led.color.multiplyScalar(state.active ? (state.intensity - 2) * .5 : .3 + power * .7);
    ledHalo.color.set(tone); ledHalo.opacity = state.halo;
    // Colored feedback is self-lit chamber geometry, so no red/green point light spills onto the floor.
    interior.emissive.set(state.active ? state.color : "#000000"); interior.emissiveIntensity = state.active ? (state.intensity - 2) * .12 : 0;
    ceilingLight.intensity = state.active ? .35 : power * .35;
    ceilingFill.intensity = .06 + illumination * .49;
    glow.emissiveIntensity = .08 + illumination * 1.07;
    purple.emissiveIntensity = .03 + illumination * .07;
    controlPurple.emissiveIntensity = .12 + illumination * .98;
    controlLight.intensity = .07 + illumination * .58;
    // The LED board glows in attract mode too, and brightens once the machine is powered.
    marquee?.material.color.setScalar(.72 + illumination * .28);
    marqueeBulbs.forEach((material, index) => {
      if (state.active) { material.color.set(state.color); material.emissive.set(state.color); material.emissiveIntensity = (state.intensity - 2) * .8; }
      else {
        const level = marqueeChase(now, index, marqueeBulbs.length, reducedMotion ? "resting" : powered ? "playing" : "waiting");
        material.emissive.set(AMBER); material.emissiveIntensity = .04 + level * 1.9 * (.6 + power * .4);
        material.color.lerpColors(BULB_GLASS, BULB_HOT, level);
      }
    });
    return illumination;
  }

  const roof = new THREE.Group(); cabinet.add(roof);
  for (const px of [-x - .09, x + .09]) block([.14, .13, d + .32], [px, h + .015, 0], purple, roof);
  for (const pz of [-z - .09, z + .09]) block([w + .32, .13, .14], [0, h + .015, pz], purple, roof);
  block([w + .32, .62, .32], [0, h + .36, z + .05], purple, canopy, .12);
  block([w + .13, .48, .045], [0, h + .36, z + .222], metal, canopy, .055);
  block([w - .02, .37, .046], [0, h + .36, z + .251], board, canopy, .035);
  // An amber LED-matrix marquee, like the glowing marquee in the key art.
  const marqueeWidth = w - .35;
  marquee = new THREE.Mesh(new THREE.PlaneGeometry(marqueeWidth, marqueeWidth * LED_ROWS / LED_COLUMNS),
    new THREE.MeshBasicMaterial({ map: ledMatrixTexture(activeMessage), transparent: true, depthWrite: false, toneMapped: false }));
  marquee.name = "LED marquee"; marquee.userData.color = LED_AMBER; marquee.position.set(0, h + .36, z + .279); canopy.add(marquee);
  block([w - .18, .028, .035], [0, h + .105, z + .245], glow, canopy, .007);
  block([.035, .028, d - .10], [x + .135, h + .07, 0], glow, canopy, .007);

  block([w + .32, .14, .34], [0, h + .65, z + .05], dark, canopy, .025);
  for (let i = 0; i < 18; i++) block([.075, .055, .024], [-w / 2 + .13 + i * (w - .26) / 17, h + .65, z + .23], lilac, canopy, .01);
  const marqueeBulbs: THREE.MeshStandardMaterial[] = [];
  const bulbGeometry = new THREE.SphereGeometry(.090, 20, 12), bezelGeometry = new THREE.TorusGeometry(.102, .010, 8, 24);
  for (let i = 0; i < 7; i++) {
    const px = -w / 2 + .24 + i * (w - .48) / 6;
    const material = new THREE.MeshStandardMaterial({ color: BULB_GLASS, emissive: AMBER, emissiveIntensity: .15, roughness: .18, metalness: .1 });
    material.name = "Amber marquee bulb";
    marqueeBulbs.push(material);
    const bulb = new THREE.Mesh(bulbGeometry, material); bulb.scale.z = .45; bulb.position.set(px, h + .65, z + .265); canopy.add(bulb);
    const bezel = new THREE.Mesh(bezelGeometry, metal); bezel.position.set(px, h + .65, z + .252); canopy.add(bezel);
  }
  // Vertical pedestal LEDs echo the glass-frame tubes without side stripes.
  for (const px of [-x + .11, x - .11]) {
    block([.075, .82, .024], [px, -.76, z + .135], dark, cabinet, .01);
    const tube = block([.025, .78, .028], [px, -.76, z + .155], glow, cabinet, .007); tube.castShadow = false;
  }
  block([w + .08, .025, .035], [0, -1.30, z + .16], glow, cabinet, .007);

  // Neon-purple controls animate from actual claw movement and the automatic drop.
  const deck = block([w + .20, .16, .58], [0, -.12, z + .24], metal);
  deck.rotation.x = .12;
  block([w - .28, .20, .40], [0, -.22, z + .28], purple, cabinet, .085);
  const inset = block([w - .13, .022, .37], [0, -.022, z + .25], dark);
  inset.rotation.x = .12;
  const joystickBase = new THREE.Mesh(new THREE.CylinderGeometry(.14, .16, .035, 24), metal);
  joystickBase.position.set(.50, .009, z + .25); cabinet.add(joystickBase);
  const joystick = new THREE.Group(); joystick.position.set(.50, .026, z + .25); cabinet.add(joystick);
  const joystickStem = new THREE.Mesh(new THREE.CylinderGeometry(.027, .027, .23, 12), metal);
  joystickStem.position.y = .115; joystick.add(joystickStem);
  const joystickBall = new THREE.Mesh(new THREE.SphereGeometry(.105, 20, 12), controlPurple);
  joystickBall.position.y = .28; joystickBall.castShadow = true; joystick.add(joystickBall);
  const controlLight = new THREE.PointLight("#ff5a2a", .65, 1.2, 2); controlLight.position.set(.7, .22, z + .28); cabinet.add(controlLight);
  const buttonBase = new THREE.Mesh(new THREE.CylinderGeometry(.155, .165, .025, 24), metal);
  buttonBase.position.set(1.08, .008, z + .25); cabinet.add(buttonBase);
  const button = new THREE.Mesh(new THREE.CylinderGeometry(.14, .145, .075, 24), controlPurple);
  button.position.set(1.08, .043, z + .25); cabinet.add(button);
  const buttonRing = new THREE.Mesh(new THREE.TorusGeometry(.151, .010, 8, 24), controlPurple); buttonRing.rotation.x = Math.PI / 2; buttonRing.position.set(1.08, .024, z + .25); cabinet.add(buttonRing);
  const play = label("PLAY", .31, [1.08, .012, z + .43], "#fff0da"); play.rotation.x = -Math.PI / 2 + .12;

  const tokenSlot = new THREE.Vector3(.68, -.60, z + .17);
  block([.36, .47, .055], [tokenSlot.x, tokenSlot.y, tokenSlot.z - .025], dark, cabinet, .045);
  block([.15, .38, .065], [tokenSlot.x, tokenSlot.y, tokenSlot.z + .012], metal, cabinet, .015);
  block([.105, .33, .07], [tokenSlot.x, tokenSlot.y, tokenSlot.z + .025], dark, cabinet, .01);
  const slotLight = new THREE.MeshStandardMaterial({ color: "#b8742a", emissive: EMBER, emissiveIntensity: .5 });
  block([.23, .025, .025], [tokenSlot.x, tokenSlot.y + .20, tokenSlot.z + .032], slotLight, cabinet, .008);
  label("TOKEN", .29, [tokenSlot.x, tokenSlot.y - .29, tokenSlot.z + .036], "#FEA911");
  const screwGeometry = new THREE.CylinderGeometry(.024, .024, .01, 12);
  for (const px of [-x - .06, x + .06]) for (const py of [.15, h - .18]) {
    const screw = new THREE.Mesh(screwGeometry, metal); screw.rotation.x = Math.PI / 2;
    screw.position.set(px, py, z + .142); cabinet.add(screw);
  }
  for (const py of [.45, h - .45]) block([.07, .12, .035], [x + .06, py, z + .105], dark, cabinet, .012);

  const delivery = { x: (POCKET.minX + POCKET.maxX) / 2, z: (POCKET.minZ + POCKET.maxZ) / 2, floorY: POCKET.floorY + MACHINE.boxSize / 2 };
  const pocketWidth = POCKET.maxX - POCKET.minX, pocketDepth = POCKET.maxZ - POCKET.minZ;
  const divider = new THREE.MeshPhysicalMaterial({ color: "#f6ece0", transparent: true, opacity: .14, roughness: .12, depthWrite: false, side: THREE.DoubleSide });
  const sideDivider = block([POCKET.wallThickness, POCKET.wallHeight, pocketDepth], [POCKET.maxX - POCKET.wallThickness / 2, POCKET.wallHeight / 2, delivery.z], divider, cabinet, .005);
  const backDivider = block([pocketWidth, POCKET.wallHeight, POCKET.wallThickness], [delivery.x, POCKET.wallHeight / 2, POCKET.minZ + POCKET.wallThickness / 2], divider, cabinet, .005);
  sideDivider.castShadow = backDivider.castShadow = false;
  block([.035, .035, pocketDepth], [POCKET.maxX - .03, POCKET.wallHeight, delivery.z], lilac, cabinet, .008);
  block([pocketWidth, .035, .035], [delivery.x, POCKET.wallHeight, POCKET.minZ + .03], lilac, cabinet, .008);
  for (const [px, pz] of [[POCKET.maxX - .03, POCKET.minZ + .03], [POCKET.maxX - .03, POCKET.maxZ - .03], [POCKET.minX + .03, POCKET.minZ + .03]]) {
    block([.028, POCKET.wallHeight, .028], [px, POCKET.wallHeight / 2, pz], lilac, cabinet, .007);
  }
  // Bright rim and recessed purple floor make the empty pocket easy to spot.
  for (const px of [POCKET.minX + .03, POCKET.maxX - .03]) block([.055, .05, pocketDepth], [px, .055, delivery.z], glow, cabinet, .01);
  for (const pz of [POCKET.minZ + .03, POCKET.maxZ - .03]) block([pocketWidth, .05, .055], [delivery.x, .055, pz], glow, cabinet, .01);
  block([pocketWidth, .04, pocketDepth], [delivery.x, POCKET.floorY - .02, delivery.z], lilac, cabinet, .01);
  block([.03, .6, pocketDepth], [POCKET.maxX - .015, -.3, delivery.z], interior, cabinet, .005);
  block([pocketWidth, .6, .03], [delivery.x, -.3, POCKET.minZ + .015], interior, cabinet, .005);
  const pocketLabel = label("PRIZE", .62, [delivery.x, POCKET.floorY + .005, delivery.z], "#fff0da"); pocketLabel.rotation.x = -Math.PI / 2;
  block([1.02, .61, .08], [delivery.x, -.76, z + .16], purple, cabinet, .065);
  block([.85, .43, .09], [delivery.x, -.76, z + .21], dark, cabinet, .045);
  block([.78, .08, .045], [delivery.x, -.93, z + .265], lilac, cabinet, .018);
  label("PRIZE", .43, [delivery.x, -.72, z + .263], "#fff0da");
  // Recessed service door, gasket, pull and lock are real cabinet hardware, without decorative stripes.
  block([.028, .82, d - .32], [x + .138, -.73, 0], dark, cabinet, .025);
  block([.032, .76, d - .38], [x + .155, -.73, 0], purple, cabinet, .018);
  block([.019, .10, .27], [x + .182, -.56, -.55], dark, cabinet, .018);
  block([.036, .032, .19], [x + .19, -.56, -.55], metal, cabinet, .012);
  const lock = new THREE.Mesh(new THREE.CylinderGeometry(.033, .033, .015, 20), metal); lock.rotation.z = Math.PI / 2; lock.position.set(x + .185, -.76, .70); cabinet.add(lock);
  block([.004, .027, .005], [x + .195, -.76, .70], dark, cabinet, .001);
  for (const px of [-x + .22, x - .22]) for (const pz of [-z + .22, z - .22]) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(.036, .036, .07, 12), metal); stem.position.set(px, -1.47, pz); cabinet.add(stem);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(.095, .105, .13, 20), dark); foot.position.set(px, -1.535, pz); foot.castShadow = true; cabinet.add(foot);
  }

  updateLighting(0, 0, true);
  return {
    delivery,
    tokenSlot,
    setMessage,
    // The original violet room lights the deck in the arcade's warm red; unlocked rooms keep their accent.
    setTheme: (theme: ClubTheme) => { controlLight.color.set(theme === "violet" ? "#ff5a2a" : themeAppearance(theme).accent); },
    setFinish: (tier: number) => { purple.userData.finishTier.value = tier; glow.userData.finishTier.value = tier; },
    setStationOffset: (x: number) => { purple.userData.finishOffset.value.x = x; glow.userData.finishOffset.value.x = x; },
    setConnected: (value: boolean) => { connected = value; },
    setPowered: (value: boolean) => { powered = value; feedback = null; },
    showResult: (success: boolean) => { powered = false; feedback = { success, started: performance.now() }; },
    updateLighting,
    setTokenReady: (ready: boolean) => { slotLight.color.set(ready ? "#FFEDCD" : "#b8742a"); slotLight.emissive.set(ready ? AMBER : EMBER); slotLight.emissiveIntensity = ready ? 1.3 : .5; },
    updateControls: (vx: number, vz: number, pressed: boolean, dt: number) => {
      const magnitude = Math.max(1, Math.hypot(vx, vz));
      joystick.rotation.z = THREE.MathUtils.damp(joystick.rotation.z, -vx / magnitude * .38, 16, dt);
      joystick.rotation.x = THREE.MathUtils.damp(joystick.rotation.x, vz / magnitude * .38, 16, dt);
      button.position.y = THREE.MathUtils.damp(button.position.y, pressed ? .006 : .043, 24, dt);
    },
    setTopView: (top: boolean) => {
      canopy.visible = !top;
      // Retain the actual glazing in both views; only the opaque marquee is cut away.
      frontGlass.visible = sideGlass.visible = topGlass.visible = true;
      frontShine.visible = sideShine.visible = !top;
    },
  };
}
