import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ARENA, MACHINE, boxTop, highestSurfaceAt, exposedBoxes, parametersFor, selectTarget, startingAim, entryPriceUsd, RULES_VERSION, type PrizeBox, type Aim, type Overrides, type LockedPull, type PullResult, type PaymentCurrency } from "./rewards";
import type { DailyArrangement } from "./daily";
import { createCabinet } from "./createCabinet";
import { POCKET } from "./config";
import { CABINET_BOUNDS, frameCabinet, screenDragWorldDelta } from "./cameraFraming";
import { createTokenModel } from "./createTokenModel";
import { boxDeliveryHeight, boxDropMotion, restingBoxRotation } from "./delivery";
import { createPrizeAppearance } from "./prizeAppearance";
import { tokenInsertionPose, TOKEN_SCALE } from "./tokenInsertion";
import { studioEnvironmentAsync } from "./studioLighting";
import { warmScene, yieldFrame } from "./shaderWarmup";
import { createPavement } from "./pavementScene";
import { createClaw } from "./createClaw";
import { planPrizeGrip, prizeGripPose, type ClawPose, type PrizeGripPlan } from "./prizeGrip";
import { GRIP_CLEARANCE, clawCablePose, type BoxPose } from "./clawGrip";
import { createClawSwing, smoothGantryPosition, releaseWallOvershoot } from "./clawSwing";
import { createPrizeGeometry, prizeLogoTexture } from "./prizeModel";
import { createCasinoRoom, stationSignY, NEON_SIGN_HEIGHT, NEON_SIGN_TUBES, NEON_SIGN_Y } from "./casinoRoom";
import { establishingShot, lookRotation } from "./introCamera";
import { createWalletCamera } from "./walletCamera";
import type { ClubTheme } from "./clubCosmetics";
import { surfaceTexture } from "./materialTextures";
import { renderPixelRatio } from "./renderBudget";
import { createPrizeBatch } from "./prizeBatch";
import { createShadowBudget } from "./shadowBudget";
import { createMachineLoop } from "./machineLoop";
import { planPrizeTransport, prizeTransportPose, isPrizeOverBay, advanceDropClock, type PrizeTransport } from "./prizeTransport";
import { settlePickup, type PickupFrame } from "./pickupPhysics";
import { createMotionFeedback, type MotionKind } from "./motionFeedback";
import { createArcadeStations, STATION_X, STATION_NAMES } from "./arcadeStations";

/** The start-up warm-up waits at most this long for the wall texture before compiling without it. */
const WALL_TEXTURE_WAIT_MS = 2500;

export type MachinePhase = "inserting" | "descending" | "grabbing" | "waiting" | "lifting" | "delivering";
export type RenderMetrics = { fps: number; calls: number; triangles: number; geometries: number; textures: number; pixelRatio: number; pixels: number; frameCpuMs: number; jsHeapMiB: number | null };
export type MachineController = {
  ready: Promise<void>;
  move: (x: number, z: number) => void;
  position: (axis: "x" | "z", percent: number, immediate?: boolean) => void;
  dragAim: (screenX: number, screenY: number) => void;
  getAim: () => Aim;
  prepareDrop: (id: string, tier: number, currency: PaymentCurrency, overrides: Overrides, authoritative?: LockedPull) => LockedPull | null;
  applyAuthoritativeBoxes: (boxes: readonly PrizeBox[]) => boolean;
  replaceArrangement: (initial: readonly PrizeBox[], boxes: readonly PrizeBox[], arrangement: DailyArrangement) => boolean;
  startDrop: () => boolean;
  cancelDrop: () => void;
  insertToken: (tier: number, autoDrop?: boolean) => Promise<void>;
  setTokenReady: (ready: boolean) => void;
  setPowered: (powered: boolean) => void;
  setConnected: (connected: boolean) => void;
  setView: (view: "front" | "top") => void;
  setTheme: (theme: ClubTheme) => void;
  setConfig: (tier: number, overrides: Overrides, debug: boolean, currency: PaymentCurrency) => void;
  resetPile: () => void;
  dispose: () => void;
  performance: () => RenderMetrics;
};

export function createMachine(host: HTMLDivElement, setup: { initialBoxes: readonly PrizeBox[]; boxes: readonly PrizeBox[]; arrangement: DailyArrangement; pickup?: (boxes: readonly PrizeBox[], transport: PrizeTransport) => Promise<PickupFrame[]>; plan?: (box: BoxPose, obstacles: readonly BoxPose[], grabPoint: { x: number; y: number; z: number }) => Promise<PrizeGripPlan | null> }, onAim: (aim: Aim) => void, onPhase: (phase: MachinePhase) => void, onComplete: (result: PullResult, boxes: PrizeBox[]) => void, resolve: (pull: LockedPull) => Promise<PullResult>, onError: (error: unknown) => void, onPileChanged: (boxes: PrizeBox[]) => void, onImpact?: () => void, onMotion?: (speed: number, kind: MotionKind) => void): MachineController {
  const motionFeedback = onMotion ? createMotionFeedback(onMotion) : null;
  const world = new THREE.Scene(), scene = new THREE.Scene(); world.add(scene);
  scene.name = "Active machine local gameplay coordinates"; scene.position.x = STATION_X[0];
  world.background = new THREE.Color("#000000");
  world.fog = new THREE.Fog("#000000", 35, 65);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 500);
  // The canvas joins the page now; its WebGL context is created by the start-up warm-up (warmPrograms), a frame after
  // this synchronous build. On a cold start each costs about 200 ms, and together they froze the loading screen for
  // over 400 ms. Nothing renders before the warm-up ends, and every use of `renderer` before then is guarded.
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  let renderer!: THREE.WebGLRenderer;
  function createRenderer() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    sizeRenderer();
  }
  // The studio environment is built by the start-up warm-up (warmPrograms), its programs linked in parallel first.
  let disposeEnvironment = () => {};
  canvas.setAttribute("aria-label", "3D CATO arcade claw machine, front view, with transparent glass, a pixel Claw Machine marquee, and a tumbled prize pile");
  canvas.setAttribute("role", "img");
  host.appendChild(canvas);
  const diagnosticPanel = new URLSearchParams(window.location.search).get("perf") === "1" ? document.createElement("div") : null;
  if (diagnosticPanel) {
    diagnosticPanel.setAttribute("aria-label", "Rendering performance");
    diagnosticPanel.style.cssText = "position:absolute;left:10px;top:10px;z-index:4;padding:6px 8px;background:#08080ddd;color:#b6f1d1;font:10px/1.5 monospace;pointer-events:none;max-width:70%";
    host.appendChild(diagnosticPanel);
  }
  // Night-shift lighting: a warm key and sky. The faint mint-teal rim of the key art is drawn on the cabinet's own edges
  // (createCabinet), because a teal lamp also tinted the faces of the pile and the chamber lining.
  scene.add(new THREE.HemisphereLight("#f7ad62", "#140c06", .25));
  const light = new THREE.DirectionalLight("#ffbe7b", 1.4);
  light.position.set(0, 8, 4);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.left = -6; light.shadow.camera.right = 6;
  light.shadow.camera.top = 6; light.shadow.camera.bottom = -6;
  light.shadow.normalBias = 0.025;
  light.shadow.radius = 8; light.shadow.blurSamples = 8;
  light.shadow.autoUpdate = false; light.shadow.needsUpdate = true;
  scene.add(light); scene.add(light.target);
  function updateStudioLighting(illumination: number) {
    light.intensity = .75 + illumination * .65;
    world.environmentIntensity = .20 + illumination * .25;
  }
  updateStudioLighting(0);
  const steelGrain = surfaceTexture("metal");
  // Neutral steel: its colour comes from the warm room it reflects, not from a blue cast of its own.
  const steel = new THREE.MeshPhysicalMaterial({ color: "#7a766f", roughness: .24, metalness: 1,
    bumpMap: steelGrain, bumpScale: .0007, clearcoat: .2, clearcoatRoughness: .16, envMapIntensity: 1.4 });
  steel.name = "Brushed stainless steel claw and gantry";
  const lilac = new THREE.MeshStandardMaterial({ color: "#4a3e33", roughness: .42, metalness: .55 });
  lilac.name = "Warm graphite gantry carriage";

  function box(size: number[], at: number[], material: THREE.Material, parent: THREE.Object3D = scene, radius = 0.025) {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius), material);
    mesh.position.set(at[0], at[1], at[2]); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh);
    return mesh;
  }
  function line(points: THREE.Vector3[], color: string, opacity = 1) {
    const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
    scene.add(object); return object;
  }
  const height = MACHINE.height;
  const pileTop = Math.max(.02, ...setup.boxes.map(boxTop));
  let clawRestY = Math.max(height - .90, Math.min(height - .25, pileTop + .78));
  const carriageY = height - .07, ropeTopY = height - .14;
  const cabinet = createCabinet(scene, 0);
  cabinet.setStationOffset(STATION_X[0]);
  const pavement = createPavement(world, STATION_X);
  const room = createCasinoRoom(world, STATION_X);
  for (let i = 0; i <= 6; i++) {
    const x = ARENA.minX + i * (ARENA.maxX - ARENA.minX) / 6, z = ARENA.minZ + i * (ARENA.maxZ - ARENA.minZ) / 6;
    line([new THREE.Vector3(x, 0.035, ARENA.minZ), new THREE.Vector3(x, 0.035, x < POCKET.maxX ? POCKET.minZ : ARENA.maxZ)], "#a8a096", 0.2);
    line([new THREE.Vector3(z > POCKET.minZ ? POCKET.maxX : ARENA.minX, 0.035, z), new THREE.Vector3(ARENA.maxX, 0.035, z)], "#a8a096", 0.2);
  }

  let initialBoxes = setup.initialBoxes, arrangement = setup.arrangement; let boxes = [...setup.boxes];
  const halos = new Map<string, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>();
  const pins = new Map<string, THREE.Mesh>();
  const cubeGeometry = createPrizeGeometry();
  const appearance = createPrizeAppearance();
  const prizeBatch = createPrizeBatch(scene, cubeGeometry, initialBoxes, boxes, appearance.packMaterials);
  const cubes = prizeBatch.cubes; prizeBatch.sync();
  // The three standby cabinets (about 100 ms of geometry on a cold start) are built by the warm-up, a frame after this
  // synchronous build and before anything is compiled or drawn; until then every use is optional.
  let stations: ReturnType<typeof createArcadeStations> | null = null, stationsConnected = false;
  function buildStations() {
    stations = createArcadeStations(world, cubeGeometry, initialBoxes, boxes, appearance.packMaterials, steel, clawRestY);
    stations.sync(boxes); stations.select(stationTier); if (stationsConnected) stations.setConnected(true);
  }
  let stationTier = 0, cameraX: number = STATION_X[0], cameraTargetX: number = STATION_X[0];
  for (const prize of initialBoxes) {
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      uniforms: { sigma: { value: new THREE.Vector2(.26, .26) }, reach: { value: .7 }, peak: { value: .5 }, tint: { value: new THREE.Color("#f8b05b") } },
      vertexShader: "varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: "varying vec2 vUv; uniform vec2 sigma; uniform float reach; uniform float peak; uniform vec3 tint; void main(){vec2 d=(vUv-.5)*2.0*reach;if(length(d)>reach)discard;float p=exp(-.5*dot(d/sigma,d/sigma));float bands=(1.0-smoothstep(0.0,.02,abs(p-.5)))+(1.0-smoothstep(0.0,.02,abs(p-.1)));gl_FragColor=vec4(tint,clamp(p*peak*.3+bands*.35,0.0,.65));}" });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material); halo.visible = false; halo.rotation.x = -Math.PI / 2; halo.renderOrder = 10; scene.add(halo); halos.set(prize.id, halo);
    const pin = new THREE.Mesh(new THREE.SphereGeometry(.035, 8, 6), new THREE.MeshBasicMaterial({ color: "#fff8de", depthTest: false })); pin.visible = false; pin.renderOrder = 11; scene.add(pin); pins.set(prize.id, pin);
  }
  const aimBounds = new THREE.BoxGeometry(MACHINE.boxSize, MACHINE.boxSize, MACHINE.boxSize);
  const selectedOutline = new THREE.LineSegments(new THREE.EdgesGeometry(aimBounds), new THREE.LineBasicMaterial({ color: "#a7efbd", depthTest: false })); aimBounds.dispose(); selectedOutline.renderOrder = 12; scene.add(selectedOutline);

  const rail = box([MACHINE.width - .12, 0.045, 0.045], [0, height - .01, 1.1], steel);
  const rodGeometry = new THREE.CylinderGeometry(.023, .023, MACHINE.width - .16, 16);
  for (const rz of [-.075, .075]) {
    const rod = new THREE.Mesh(rodGeometry, steel); rod.rotation.z = Math.PI / 2; rod.position.set(0, .018, rz); rod.castShadow = true; rail.add(rod);
  }
  for (const rx of [-MACHINE.width / 2 + .15, MACHINE.width / 2 - .15]) {
    const track = new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, MACHINE.depth - .12, 16), steel);
    track.rotation.x = Math.PI / 2; track.position.set(rx, height - .07, 0); scene.add(track);
    const pulley = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .038, 16), steel);
    pulley.rotation.x = Math.PI / 2; pulley.position.set(rx, -.015, 0); rail.add(pulley);
  }
  box([.30, .38, .34], [-MACHINE.width / 2 + .22, height - .22, -MACHINE.depth / 2 + .25], steel, scene, .065);
  const carriage = box([0.28, 0.12, 0.28], [0, carriageY, 1.1], lilac);
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(.016, .016, 1, 12), new THREE.MeshStandardMaterial({ color: "#58534d", roughness: .32, metalness: .95, bumpMap: steelGrain, bumpScale: .00045 })); scene.add(rope);
  const clawModel = createClaw(scene, steel), claw = clawModel.claw;
  const targetMaterial = new THREE.MeshBasicMaterial({ color: "#a7efbd", side: THREE.DoubleSide, transparent: true, opacity: .9 });
  const target = new THREE.Mesh(new THREE.RingGeometry(.24, .27, 40), targetMaterial); target.rotation.x = -Math.PI / 2; scene.add(target);
  const guide = line([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)], "#ffdcaf", .3);
  const initialAim = startingAim(boxes);
  let x = initialAim.x, z = initialAim.z, visualX = x, visualZ = z, dx = 0, dz = 0, tier = 0; let overrides: Overrides = {}, debug = false; let paymentCurrency: PaymentCurrency = "USDC";
  let mode: "idle" | "prepared" | "planning" | "waiting" | "animating" | "inserting" = "idle";
  const slotClip = new THREE.Plane(new THREE.Vector3(0, 0, 1), -cabinet.tokenSlot.z - .064);
  const insertionModels = [0, 1, 2].map(tier => {
    const model = createTokenModel(tier, prizeLogoTexture()); model.scale.setScalar(TOKEN_SCALE); model.visible = false;
    model.traverse(object => { if (object instanceof THREE.Mesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => { material.clippingPlanes = [slotClip]; }); });
    scene.add(model); return model;
  });
  let insertion: { model: THREE.Group; started: number; autoDrop: boolean; resolve: () => void; reject: (error: Error) => void } | null = null;
  let view: "front" | "top" = "front";
  let disposed = false, dropStart = 0, waitingStart = 0, drawRequested = false;
  let picked: THREE.Mesh | null = null, pull: LockedPull | null = null, result: PullResult | null = null;
  const original = new THREE.Vector3();
  let gripPlan: PrizeGripPlan | null = null, gripOrigin: ClawPose | null = null;
  let gripPlanning: Promise<void> | null = null;
  const releasedRotation = new THREE.Quaternion(), restingRotation = new THREE.Quaternion();
  let releaseY = 0, releaseFloorY = 0, releaseStarted = 0, dropImpacted = false;
  let deliveryY = cabinet.delivery.floorY;
  let lastControlX = x, lastControlZ = z, joystickPulseX = 0, joystickPulseZ = 0;
  let grabHeight = .05;
  let transport: PrizeTransport | null = null, pickupFrames: PickupFrame[] | null = null;
  let pickupPlanning: Promise<{ transport: PrizeTransport; frames: PickupFrame[] }> | null = null;
  let dropElapsed = 0, landed = false;
  const rotationA = new THREE.Quaternion(), rotationB = new THREE.Quaternion();
  let lastAimReport = 0, reportedX = x, reportedZ = z;
  let previousPhase: MachinePhase | null = null;
  let frameCpuMs = 0;
  let warming = true;
  const refreshShadows = createShadowBudget();
  let metricWindowStart = performance.now(), renderedFrames = 0, measuredFps = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Hold a wide view until authentication. Machine lights follow the completed dolly.
  const director = createWalletCamera(camera, connected => { cabinet.setConnected(connected); stationsConnected = connected; stations?.setConnected(connected); });
  let revealed = false, startupRendered = false;
  const currentPose = () => ({ position: camera.position.clone(), quaternion: camera.quaternion.clone() });
  let signY = NEON_SIGN_Y;
  function establishingPose() {
    if (view === "top") {
      const center = CABINET_BOUNDS.getCenter(new THREE.Vector3()); center.x = cameraX;
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
      return { position: camera.position.clone().addScaledVector(back, camera.position.distanceTo(center) * .45), quaternion: camera.quaternion.clone() };
    }
    const shot = establishingShot(camera.aspect, camera.fov, cameraX, signY + NEON_SIGN_HEIGHT / 2, NEON_SIGN_TUBES.width / 2);
    return { position: shot.position, quaternion: lookRotation(shot.position, shot.target) };
  }
  function revealScene(now: number) {
    revealed = true; renderer.domElement.dataset.sceneReadyAt = String(Math.round(now));
    // Room signage remains visible in standby; the cabinet itself stays dim.
    room.powerOn(now, reducedMotion.matches, cameraTargetX);
  }
  function endIntro(immediate: boolean) { if (immediate) director.land(); }
  const swing = createClawSwing(x, z);
  const speedFactor = () => reducedMotion.matches ? .22 : 1;
  const ease = (t: number) => { const v = THREE.MathUtils.clamp(t, 0, 1); return v * v * (3 - 2 * v); };
  const phase = (next: MachinePhase) => { if (next !== previousPhase) { previousPhase = next; cabinet.setMessage({ inserting: "INSERT TOKEN", descending: "GOOD LUCK", grabbing: "HOLD TIGHT", waiting: "HOLD TIGHT", lifting: "GOOD LUCK", delivering: "PRIZE TIME" }[next]); onPhase(next); } };
  function updateAim(nextX: number, nextZ: number) { const bounds = clawModel.travelBounds; x = THREE.MathUtils.clamp(nextX, Math.max(ARENA.minX, bounds.minX), Math.min(ARENA.maxX, bounds.maxX)); z = THREE.MathUtils.clamp(nextZ, Math.max(ARENA.minZ, bounds.minZ), Math.min(ARENA.maxZ, bounds.maxZ)); }
  function nudgeAim(changeX: number, changeZ: number) {
    const bounds = clawModel.travelBounds;
    const nextX = releaseWallOvershoot(x, x + changeX, visualX, bounds.minX, bounds.maxX);
    const nextZ = releaseWallOvershoot(z, z + changeZ, visualZ, bounds.minZ, bounds.maxZ);
    visualX = nextX.visual; visualZ = nextZ.visual;
    updateAim(nextX.target, nextZ.target);
  }
  let poseBoxes: readonly PrizeBox[] | null = null, poseCache: BoxPose[] = [];
  function visibleBoxPoses(): BoxPose[] {
    if (poseBoxes === boxes) return poseCache;
    poseBoxes = boxes;
    poseCache = boxes.map(box => { const cube = cubes.get(box.id)!; return { id: box.id, size: box.size, center: cube.position, rotation: cube.quaternion }; });
    return poseCache;
  }
  function currentGripBox(): BoxPose | null {
    return picked && pull?.target ? { id: pull.target.box.id, size: pull.target.box.size, center: picked.position, rotation: picked.quaternion } : null;
  }
  function beginDrop() {
    const id = pull?.id; mode = "planning"; dx = dz = 0;
    void (gripPlanning ?? Promise.resolve()).then(() => {
      if (disposed || pull?.id !== id) return;
      pickupPlanning = null;
      if (pull?.target && gripPlan && setup.pickup) {
        // Overlap presentation physics with descent; it never draws or awards a prize.
        const planned = planPrizeTransport(pull.target.box, gripPlan);
        pickupPlanning = setup.pickup(boxes.filter(box => box.id !== pull!.target!.box.id), planned).then(frames => ({ transport: planned, frames }));
        void pickupPlanning.catch(() => {});
      }
      gripOrigin = clawModel.snapshotPose(); mode = "animating"; dropStart = performance.now(); dropElapsed = 0; landed = false; transport = null; pickupFrames = null; phase("descending");
    }).catch(error => {
      if (disposed || pull?.id !== id) return;
      mode = "idle"; pull = null; picked = null; gripPlan = null; gripPlanning = null; onError(error);
    });
  }
  function finish() {
    if (!result || (result.success && (!landed || picked?.parent === claw || pickupFrames))) return;
    const completed = result;
    if (completed.success && picked) {
      scene.attach(picked); picked.position.y = deliveryY; picked.visible = false;
      boxes = boxes.filter((box) => box.id !== completed.targetId);
    }
    cabinet.showResult(completed.success);
    mode = "idle"; dx = dz = 0; picked = null; pull = null; result = null; gripPlan = null; gripOrigin = null; pickupPlanning = null; onComplete(completed, [...boxes]);
  }
  function requestDraw(now: number) {
    if (drawRequested || !pull) return;
    // Resolve the original locked odds. Rendered finger contacts cannot penalize or reroll an attempt.
    drawRequested = true; mode = "waiting"; waitingStart = now; phase("waiting");
    const locked = pull;
    void resolve(locked).then(async (resolved) => {
      if (disposed || pull?.id !== locked.id) return;
      if (resolved.pullId !== locked.id || resolved.targetId !== (locked.target?.box.id ?? null) || resolved.probability !== (locked.target?.probability ?? 0)
        || (locked.target !== null && resolved.roll === null) || (locked.target === null && resolved.roll !== null)
        || (resolved.roll !== null && (!Number.isFinite(resolved.roll) || resolved.roll < 0 || resolved.roll >= 1))
        || resolved.success !== (resolved.roll !== null && resolved.roll < resolved.probability) || resolved.cents !== (resolved.success ? locked.target!.box.cents : 0)) throw new Error("Draw does not match locked attempt");
      result = resolved;
      if (result.success && picked) {
        const prepared = await (pickupPlanning ?? (async () => {
          const remaining = boxes.filter(box => box.id !== locked.target!.box.id);
          const planned = planPrizeTransport(locked.target!.box, gripPlan ?? clawModel.snapshotPose());
          const frames = setup.pickup ? await setup.pickup(remaining, planned) : settlePickup(remaining, planned);
          return { transport: planned, frames };
        })());
        if (disposed || pull?.id !== locked.id) return;
        transport = prepared.transport; pickupFrames = prepared.frames; pickupPlanning = null;
        claw.attach(picked);
        boxes = pickupFrames.at(-1)!.boxes;
        onPileChanged([...boxes]);
      }
      dropStart += performance.now() - waitingStart; mode = "animating";
    }).catch((error) => {
      if (disposed) return;
      if (picked) { scene.attach(picked); picked.position.copy(original); }
      mode = "idle"; pull = null; result = null; picked = null; pickupPlanning = null; dx = dz = 0; onError(error);
    });
  }
  let overlayBoxes: readonly PrizeBox[] | null = null, overlayTier = -1, overlayOverrides: Overrides | null = null, overlayX = NaN, overlayZ = NaN;
  let overlaySelection: ReturnType<typeof selectTarget> = null, overlaysShown = false;
  function overlays() {
    if (!debug) {
      if (overlaysShown) { halos.forEach(halo => { halo.visible = false; }); pins.forEach(pin => { pin.visible = false; }); overlaysShown = false; }
      selectedOutline.visible = target.visible = false;
      return null;
    }
    overlaysShown = true;
    if (overlayBoxes !== boxes || overlayTier !== tier || overlayOverrides !== overrides || overlayX !== claw.position.x || overlayZ !== claw.position.z) {
      overlayBoxes = boxes; overlayTier = tier; overlayOverrides = overrides; overlayX = claw.position.x; overlayZ = claw.position.z;
      overlaySelection = selectTarget({ x: overlayX, z: overlayZ }, boxes, tier, overrides, paymentCurrency);
    }
    const available = exposedBoxes(boxes), visibleIds = new Set(available.map((box) => box.id));
    const selection = pull?.target ?? overlaySelection;
    for (const initial of initialBoxes) {
      const prize = boxes.find((box) => box.id === initial.id);
      const halo = halos.get(initial.id)!, pin = pins.get(initial.id)!;
      halo.visible = pin.visible = !!prize && debug && mode === "idle" && visibleIds.has(initial.id);
      if (!halo.visible || !prize) continue;
      const p = parametersFor(prize, tier, overrides, paymentCurrency), selected = selection?.box.id === prize.id;
      halo.position.set(p.grabPoint.x, p.grabPoint.y + .015, p.grabPoint.z); halo.scale.setScalar(Math.max(.001, p.maxReach * 2));
      halo.material.uniforms.sigma.value.set(p.sigmaX, p.sigmaZ); halo.material.uniforms.reach.value = p.maxReach;
      halo.material.uniforms.peak.value = p.maxPickupProbability * (p.exposure ?? 1) * (p.gripSuitability ?? 1);
      halo.visible = halo.material.uniforms.peak.value > 0;
      halo.material.uniforms.tint.value.set(selected ? "#91f2b3" : "#f4b15d"); pin.position.set(p.grabPoint.x, p.grabPoint.y + .04, p.grabPoint.z);
    }
    selectedOutline.visible = debug && !!selection && mode === "idle";
    if (selection) {
      selectedOutline.position.set(selection.box.center.x, selection.box.center.y, selection.box.center.z);
      const q = selection.box.rotation; selectedOutline.quaternion.set(q.x, q.y, q.z, q.w);
    }
    target.position.set(claw.position.x, (selection?.parameters.grabPoint.y ?? .025) + .03, claw.position.z); target.visible = debug && mode === "idle";
    return selection;
  }
  function animate(now: number, dt: number, render: boolean) {
    if (disposed || warming) return;
    const frameStarted = performance.now();
    if (Math.abs(cameraX - cameraTargetX) > .0001) {
      const next = reducedMotion.matches ? cameraTargetX : THREE.MathUtils.damp(cameraX, cameraTargetX, 6, dt);
      camera.position.x += next - cameraX; cameraX = next; camera.updateMatrixWorld();
    }
    // Plain markers (data-scene-ready-at, data-intro) let a recording or a check find the reveal: when it began and whether it flew.
    const loadingCovered = document.querySelector("[data-arcade-loading]") !== null;
    if (!revealed && render && !loadingCovered) revealScene(now);
    // Pause the wallet reveal while a dialog or hidden tab obscures it.
    director.frame(dt, !document.hidden && !loadingCovered && document.querySelector("dialog[open]") === null);
    // Wide, unsigned standby is already a landed view; the tutorial needn't wait for wallet authentication.
    renderer.domElement.dataset.intro = director.state === "holding" ? "done" : director.state;
    room.update(now, reducedMotion.matches);
    if (mode === "animating") dropElapsed = advanceDropClock(dropElapsed, dt, speedFactor());
    if (pickupFrames) {
      const elapsed = Math.max(0, dropElapsed - 1550), end = pickupFrames.findIndex(f => f.atMs > elapsed);
      const a = pickupFrames[end < 0 ? pickupFrames.length - 1 : Math.max(0, end - 1)], b = pickupFrames[end < 0 ? pickupFrames.length - 1 : end];
      const mix = a === b ? 0 : THREE.MathUtils.clamp((elapsed - a.atMs) / (b.atMs - a.atMs), 0, 1);
      for (let i = 0; i < a.boxes.length; i++) {
        const from = a.boxes[i], to = b.boxes[i], cube = cubes.get(from.id)!;
        cube.position.set(THREE.MathUtils.lerp(from.center.x, to.center.x, mix), THREE.MathUtils.lerp(from.center.y, to.center.y, mix), THREE.MathUtils.lerp(from.center.z, to.center.z, mix));
        rotationA.set(from.rotation.x, from.rotation.y, from.rotation.z, from.rotation.w); rotationB.set(to.rotation.x, to.rotation.y, to.rotation.z, to.rotation.w); cube.quaternion.slerpQuaternions(rotationA, rotationB, mix);
      }
      if (end < 0) pickupFrames = null;
    }
    if (mode === "idle" && (dx || dz)) { const speed = 1.55 * dt / Math.max(1, Math.hypot(dx, dz)); nudgeAim(dx * speed, dz * speed); }
    visualX = smoothGantryPosition(visualX, x, dt); visualZ = smoothGantryPosition(visualZ, z, dt);
    let cx = visualX, cz = visualZ, cy = clawRestY, closed = 0;
    if (insertion) {
      const progress = THREE.MathUtils.clamp((now - insertion.started) / (850 * speedFactor()), 0, 1);
      const pose = tokenInsertionPose(cabinet.tokenSlot, progress);
      insertion.model.position.copy(pose.position); insertion.model.rotation.set(0, pose.rotationY, 0);
      if (progress >= 1) {
        const completed = insertion; insertion = null; completed.model.visible = false;
        cabinet.setTokenReady(true); cabinet.setPowered(true);
        if (completed.autoDrop) { visualX = x; visualZ = z; beginDrop(); } else mode = "idle";
        completed.resolve();
      }
    }
    const lowY = gripPlan?.position.y ?? Math.max(grabHeight + GRIP_CLEARANCE, MACHINE.floorY + .74);
    let guidedPose: ClawPose | null = null;
    let presentationYaw = new THREE.Quaternion();
    if (mode === "waiting") { cx = gripPlan?.position.x ?? x; cz = gripPlan?.position.z ?? z; cy = lowY; closed = 1;
      if (gripPlan && gripOrigin) guidedPose = prizeGripPose(gripOrigin, gripPlan, 1550);
    }
    if (mode === "animating") {
      cx = gripPlan?.position.x ?? x; cz = gripPlan?.position.z ?? z;
      const t = dropElapsed;
      const carryEnd = 1550 + (transport?.durationMs ?? 1350), returnStart = carryEnd + 1500, returnEnd = returnStart + 750;
      if (gripPlan && gripOrigin) {
        if (t <= 1550 || !drawRequested) guidedPose = prizeGripPose(gripOrigin, gripPlan, Math.min(t, 1550));
        const yawWeight = result?.success ? 1 - ease((t - returnStart) / 750) : 1 - ease((t - 1550) / 1100);
        presentationYaw = new THREE.Quaternion().slerp(gripPlan.rotation, yawWeight);
      }
      if (t < 1100) { phase("descending"); cy = THREE.MathUtils.lerp(clawRestY, lowY, ease(t / 1100)); }
      else if (t < 1550) { phase("grabbing"); cy = lowY; closed = ease((t - 1100) / 450); }
      else if (!drawRequested) { cy = lowY; closed = 1; requestDraw(now); }
      else if (result?.success && transport && t < carryEnd) {
        phase(t < 2250 ? "lifting" : "delivering"); closed = 1;
        guidedPose = prizeTransportPose(transport, t - 1550); cy = guidedPose.position.y;
      }
      else if (t < 2650) {
        phase("lifting"); const progress = ease((t - 1550) / 1100); cy = THREE.MathUtils.lerp(lowY, clawRestY, progress);
        closed = result?.success ? 1 : 1 - progress;
        // A miss withdraws along the same clear approach path; the prize stays in the pile.
        if (!result?.success && gripPlan && gripOrigin) guidedPose = prizeGripPose(gripOrigin, gripPlan, 1550 * (1 - progress));
      } else if (!result?.success) finish();
      else if (!landed || t < returnStart) {
        const delivered = prizeTransportPose(transport!, transport!.durationMs);
        phase("delivering"); cx = delivered.position.x; cz = delivered.position.z; cy = delivered.position.y; presentationYaw.copy(delivered.rotation); closed = 1 - ease((t - carryEnd) / 300);
        // Keep the fixed carrier pose until the real world-space box is above the chute.
        if (picked!.parent === claw) guidedPose = delivered;
        const overBay = isPrizeOverBay({ size: pull!.target!.box.size, center: scene.worldToLocal(picked!.getWorldPosition(new THREE.Vector3())), rotation: picked!.getWorldQuaternion(new THREE.Quaternion()) });
        if (picked!.parent === claw && closed < .985 && overBay) {
          scene.attach(picked!); releaseY = picked!.position.y; releasedRotation.copy(picked!.quaternion);
          restingRotation.copy(restingBoxRotation(releasedRotation)); releaseFloorY = boxDeliveryHeight(releasedRotation); releaseStarted = t;
          guidedPose = null;
        }
        if (picked!.parent !== claw) {
          const fall = boxDropMotion(releaseY, releaseFloorY, (t - releaseStarted) / 1000);
          if (fall.contact) {
            if (!dropImpacted) { dropImpacted = true; onImpact?.(); }
            picked!.quaternion.slerpQuaternions(releasedRotation, restingRotation, fall.settle);
            deliveryY = boxDeliveryHeight(picked!.quaternion); picked!.position.y = deliveryY + fall.y - releaseFloorY;
          } else picked!.position.y = fall.y;
          landed = fall.done;
        }
        if (!landed && t >= returnStart - 50) dropElapsed = returnStart - 50;
      } else if (t < returnEnd) {
        phase("delivering"); picked!.position.y = deliveryY;
        const delivered = prizeTransportPose(transport!, transport!.durationMs), p = ease((t - returnStart) / 750);
        cx = THREE.MathUtils.lerp(delivered.position.x, x, p); cz = THREE.MathUtils.lerp(delivered.position.z, z, p); cy = THREE.MathUtils.lerp(delivered.position.y, clawRestY, p);
      }
      else finish();
    }
    // Keep the visible carriage within the full rigid-finger envelope, independent of logical aim/odds.
    const traveling = mode === "idle" || mode === "prepared" || mode === "inserting" || mode === "planning";
    const bounds = traveling ? clawModel.travelBounds : picked?.parent === claw ? clawModel.activeMovementBounds(presentationYaw) : clawModel.movementBounds;
    const baseX = THREE.MathUtils.clamp(cx, bounds.minX, bounds.maxX), baseZ = THREE.MathUtils.clamp(cz, bounds.minZ, bounds.maxZ);
    const angles = swing(baseX, baseZ, dt, reducedMotion.matches);
    const sway = traveling ? 1 : mode === "animating" ? 1 - ease((now - dropStart) / (650 * speedFactor())) : 0;
    const edgeDistance = Math.min(baseX - bounds.minX, bounds.maxX - baseX, baseZ - bounds.minZ, bounds.maxZ - baseZ);
    const edgeSway = THREE.MathUtils.smoothstep(edgeDistance, 0, .30);
    const length = Math.max(.01, ropeTopY - cy), sx = angles.x * sway * edgeSway, sz = angles.z * sway * edgeSway;
    claw.position.set(baseX + Math.sin(sx) * length, cy + length * (1 - Math.cos(Math.hypot(sx, sz))), baseZ + Math.sin(sz) * length);
    const desiredUp = new THREE.Vector3(baseX, ropeTopY, baseZ).sub(claw.position).normalize();
    claw.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), desiredUp).multiply(presentationYaw);
    if (guidedPose) clawModel.presentGripPose(guidedPose);
    else clawModel.update(closed, currentGripBox(), visibleBoxPoses(), picked?.parent === claw, traveling);
    if (mode === "idle" && now - lastAimReport >= 80 && Math.hypot(claw.position.x - reportedX, claw.position.z - reportedZ) > .002) {
      reportedX = claw.position.x; reportedZ = claw.position.z; lastAimReport = now; onAim({ x: reportedX, z: reportedZ });
    }
    motionFeedback?.sample(claw.position, dt, now, mode === "idle" ? "aim" : "hoist", document.hidden || mode === "waiting");
    // The cable, rail and carriage follow the resolved pose, including any visual collision stop.
    const cable = clawCablePose(claw.position, claw.quaternion, ropeTopY);
    rail.position.z = cable.anchor.z; carriage.position.set(cable.anchor.x, carriageY, cable.anchor.z);
    rope.position.copy(claw.position).add(cable.anchor).multiplyScalar(.5); rope.scale.y = cable.length;
    rope.quaternion.copy(claw.quaternion);
    const changeX = x - lastControlX, changeZ = z - lastControlZ;
    if (mode === "idle" && (Math.abs(changeX) + Math.abs(changeZ) > .00001)) {
      const magnitude = Math.max(.0001, Math.hypot(changeX, changeZ));
      joystickPulseX = changeX / magnitude; joystickPulseZ = changeZ / magnitude;
    } else {
      joystickPulseX = THREE.MathUtils.damp(joystickPulseX, 0, 12, dt);
      joystickPulseZ = THREE.MathUtils.damp(joystickPulseZ, 0, 12, dt);
    }
    cabinet.updateControls(joystickPulseX, joystickPulseZ, mode !== "idle" && drawRequested === false && (now - dropStart) / speedFactor() < 500, dt);
    const illumination = cabinet.updateLighting(now, dt, reducedMotion.matches);
    stations?.update(now, dt, reducedMotion.matches);
    appearance.update(illumination); updateStudioLighting(illumination);
    lastControlX = x; lastControlZ = z;
    const selection = overlays(); guide.position.set(claw.position.x, selection?.parameters.grabPoint.y ?? .025, claw.position.z);
    guide.scale.y = Math.max(.05, cy - guide.position.y - .45); guide.visible = debug && mode === "idle";
    const zoom = THREE.MathUtils.damp(camera.zoom, mode === "idle" || mode === "prepared" ? 1 : 1.025, 4, dt);
    if (Math.abs(camera.zoom - zoom) > .00001) { camera.zoom = zoom; camera.updateProjectionMatrix(); }
    if (!render) return;
    const pileChanged = prizeBatch.sync();
    const shadowPose = [...claw.position.toArray(), ...claw.quaternion.toArray(), ...clawModel.snapshotPose().angles, joystickPulseX, joystickPulseZ, mode === "idle" ? 0 : 1,
      ...(picked ? [...picked.position.toArray(), ...picked.quaternion.toArray(), Number(picked.visible)] : [])];
    if (refreshShadows(now, shadowPose, pileChanged)) light.shadow.needsUpdate = true;
    // The startup render compiles shaders and builds the scene, so it also draws the signs' dark lit layers: lighting a
    // sign during the fly-in then costs nothing. The fly-in's clock starts only on a frame after this render.
    const startup = !startupRendered;
    if (startup) room.primeSigns();
    renderer.info.reset(); pavement.captureReflection(renderer, camera, now, mode !== "idle" || !!director.flight || Math.abs(cameraX-cameraTargetX)>.01, view !== "top"); renderer.render(world, camera);
    if (startup) startupRendered = true;
    frameCpuMs = THREE.MathUtils.lerp(frameCpuMs, performance.now() - frameStarted, .1);
    renderedFrames++;
    if (now - metricWindowStart >= 1000) {
      measuredFps = renderedFrames * 1000 / (now - metricWindowStart); metricWindowStart = now; renderedFrames = 0;
      if (diagnosticPanel) {
        const metrics = performanceMetrics();
        diagnosticPanel.textContent = `${metrics.fps.toFixed(0)} FPS · ${metrics.calls} calls · CPU ${metrics.frameCpuMs.toFixed(1)}ms · DPR ${metrics.pixelRatio.toFixed(2)} · ${metrics.textures} textures`;
      }
    }
  }
  const loop = createMachineLoop(animate, () => mode !== "idle");
  /** Reframe the wide standby and close playing views when the stage changes size. */
  function frameStation() {
    if (!host.clientWidth || !host.clientHeight) return false;
    const previousPose = currentPose();
    frameCabinet(camera, host.clientWidth / host.clientHeight, view === "top");
    camera.position.x += cameraX; camera.updateMatrixWorld();
    // Keep the larger sign fixed on the wall; close-up framing may crop it.
    if (view === "front") { signY = stationSignY(camera, host.clientWidth, host.clientHeight); room.setSignHeight(signY); }
    director.setFraming(establishingPose(), currentPose(), reducedMotion.matches, previousPose);
    return true;
  }
  /** Size the drawing buffer for the stage (before the context exists, only the canvas's box). */
  function sizeRenderer() {
    if (!host.clientWidth || !host.clientHeight) return false;
    if (!renderer) { canvas.style.width = `${host.clientWidth}px`; canvas.style.height = `${host.clientHeight}px`; return false; }
    renderer.setPixelRatio(renderPixelRatio(host.clientWidth, host.clientHeight, window.devicePixelRatio));
    renderer.setSize(host.clientWidth, host.clientHeight);
    return true;
  }
  function resize() {
    pavement.invalidateReflection();
    if (!frameStation() || !sizeRenderer()) return;
    if (!warming && !document.hidden) { light.shadow.needsUpdate = true; renderer.info.reset(); renderer.render(world, camera); }
  }
  function visibility() {
    if (document.hidden) motionFeedback?.stop();
    if (document.hidden) dx = dz = 0;
    metricWindowStart = performance.now(); renderedFrames = 0; loop.visibility();
  }
  // Continue the locked round on a timer, with GPU submissions only when visible.
  document.addEventListener("visibilitychange", visibility);
  const observer = new ResizeObserver(resize); observer.observe(host); resize(); onAim({ x, z });
  claw.position.set(x, clawRestY, z); clawModel.update(0, null, visibleBoxPoses(), false, true);
  // Warm every shader program the first seconds draw before the loop starts and play is enabled, through the parallel
  // path (KHR_parallel_shader_compile, in small slices), so the loading screen keeps animating while they link.
  const ready = warmPrograms().then(() => {
    if (disposed) return;
    warming = false; metricWindowStart = performance.now(); loop.start();
  });
  async function warmPrograms() {
    // A painted frame between each piece of the start-up (the active machine, the standby cabinets, the WebGL context,
    // the environment's compile work), so none adds to another's task and the loading screen keeps moving.
    await yieldFrame(); if (disposed) return;
    buildStations();
    await yieldFrame(); if (disposed) return;
    createRenderer();
    await yieldFrame(); if (disposed) return;
    // The environment map changes every lit material's program, so it comes first. Meanwhile the wall's slat texture
    // arrives (briefly awaited): it switches the wall to another program, compiled here rather than linked synchronously
    // in the middle of the fly-in.
    const [environment] = await Promise.all([studioEnvironmentAsync(renderer, world, () => disposed),
      Promise.race([room.wallLoaded, new Promise(resolve => setTimeout(resolve, WALL_TEXTURE_WAIT_MS))])]);
    disposeEnvironment = environment;
    if (disposed) { environment(); return; }
    // The lit sign layers are hidden until a sign powers on. compile() takes every material in the scene, hidden or not,
    // but only the visible lights; show the layers (still dark) as the startup render does, so the two match.
    room.primeSigns();
    // The screen pass, and every pass into a render target: the floor reflection and the glass's transmission pass.
    // Three builds separate programs for any bound target, and on a cold shader cache linking them inside the first
    // frame froze the loading screen for 4-5 s; compiling with the reflection's target bound covers both passes.
    await warmScene(renderer, world, camera, [null, pavement.reflectionTarget], () => disposed);
  }
  function performanceMetrics(): RenderMetrics {
    if (!renderer) return { fps: 0, calls: 0, triangles: 0, geometries: 0, textures: 0, pixelRatio: 0, pixels: 0, frameCpuMs: 0, jsHeapMiB: null };
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return { fps: measuredFps, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      pixelRatio: renderer.getPixelRatio(), pixels: buffer.x * buffer.y, frameCpuMs, jsHeapMiB: memory ? memory.usedJSHeapSize / 1048576 : null };
  }
  return {
    ready,
    insertToken: (tokenTier, autoDrop = false) => {
      if (disposed || (autoDrop ? mode !== "prepared" : mode !== "idle") || !Number.isInteger(tokenTier) || tokenTier < 0 || tokenTier > 2) return Promise.reject(new Error("Cannot insert a token now"));
      endIntro(true); cabinet.setPowered(false); mode = "inserting"; dx = dz = 0;
      const model = insertionModels[tokenTier]; model.visible = true; model.position.copy(tokenInsertionPose(cabinet.tokenSlot, 0).position); model.rotation.set(0, 0, 0);
      return new Promise<void>((resolve, reject) => { insertion = { model, started: performance.now(), autoDrop, resolve, reject }; });
    },
    setTokenReady: cabinet.setTokenReady,
    setPowered: cabinet.setPowered,
    setConnected: (connected) => { director.setConnected(connected, reducedMotion.matches); },
    move: (nx, nz) => { if (mode === "idle") { if (nx || nz) endIntro(false); dx = THREE.MathUtils.clamp(nx, -1, 1); dz = THREE.MathUtils.clamp(nz, -1, 1); } },
    position: (axis, percent, immediate = false) => { if (mode === "idle" && Number.isFinite(percent)) {
      endIntro(false); dx = dz = 0; const v = THREE.MathUtils.clamp(percent, 0, 100) / 100;
      updateAim(axis === "x" ? ARENA.minX + v * (ARENA.maxX - ARENA.minX) : x, axis === "z" ? ARENA.minZ + v * (ARENA.maxZ - ARENA.minZ) : z);
      if (immediate) { visualX = x; visualZ = z; claw.position.set(x, clawRestY, z); claw.quaternion.identity(); clawModel.update(0, null, visibleBoxPoses(), false, true); onAim({ x: claw.position.x, z: claw.position.z }); }
    } },
    dragAim: (screenX, screenY) => {
      if (mode !== "idle" || disposed || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
      // Stable horizontal-plane controls also work with a low product-shot camera.
      endIntro(false);
      const movement = screenDragWorldDelta(camera, screenX, screenY);
      dx = dz = 0; nudgeAim(movement.x, movement.z);
    },
    getAim: () => ({ x: claw.position.x, z: claw.position.z }),
    prepareDrop: (id, bet, currency, tuning, authoritative) => {
      if (mode !== "idle" || disposed || warming) return null;
      const aim = authoritative?.aim ?? Object.freeze({ x: claw.position.x, z: claw.position.z });
      x = visualX = aim.x; z = visualZ = aim.z; onAim(aim);
      const selected = authoritative ? authoritative.target : selectTarget(aim, boxes, bet, tuning, currency);
      grabHeight = Math.max(selected?.parameters.grabPoint.y ?? .05, highestSurfaceAt(aim, boxes)?.y ?? .05);
      const targetSnapshot = selected ? Object.freeze({ box: selected.box, parameters: selected.parameters, probability: selected.probability }) : null;
      pull = authoritative ?? Object.freeze({ id, rulesVersion: RULES_VERSION, aim, target: targetSnapshot, tier: bet, currency, priceUsd: entryPriceUsd(bet, currency), arrangement });
      mode = "prepared"; dx = dz = 0; previousPhase = null; drawRequested = false; dropImpacted = false; result = null;
      picked = selected ? cubes.get(selected.box.id)! : null; gripPlan = null; gripOrigin = null; gripPlanning = null;
      if (picked && selected) {
        original.copy(picked.position);
        const contactBox = { id: selected.box.id, size: selected.box.size, center: { x: picked.position.x, y: picked.position.y, z: picked.position.z }, rotation: { x: picked.quaternion.x, y: picked.quaternion.y, z: picked.quaternion.z, w: picked.quaternion.w } };
        if (setup.plan) {
          const snapshot = visibleBoxPoses().map(pose => ({ ...pose, center: { ...pose.center }, rotation: { x: pose.rotation.x, y: pose.rotation.y, z: pose.rotation.z, w: pose.rotation.w } }));
          gripPlanning = setup.plan(contactBox, snapshot, selected.parameters.grabPoint).then(plan => { if (!disposed && pull?.id === id) gripPlan = plan; });
          // Insertion overlaps planning; beginDrop handles rejection when it is time to descend.
          void gripPlanning.catch(() => {});
        } else gripPlan = planPrizeGrip(contactBox, visibleBoxPoses(), selected.parameters.grabPoint);
      }
      return pull;
    },
    startDrop: () => { if (mode !== "prepared" || disposed) return false; cabinet.setPowered(true); beginDrop(); return true; },
    replaceArrangement: (nextInitial, next, nextArrangement) => {
      if (mode !== "idle" || disposed || warming || !prizeBatch.canReplace(nextInitial, next) || !stations?.canReplace(nextInitial, next)) return false;
      prizeBatch.replace(nextInitial, next); stations.replace(nextInitial, next);
      initialBoxes = nextInitial; boxes = [...next]; arrangement = nextArrangement;
      poseBoxes = overlayBoxes = null; pickupFrames = null; transport = null; gripPlan = gripOrigin = null; picked = pull = result = null;
      clawRestY = Math.max(height - .90, Math.min(height - .25, Math.max(.02, ...boxes.map(boxTop)) + .78));
      claw.position.y = clawRestY; cabinet.setPowered(false); cabinet.setTokenReady(false);
      light.shadow.needsUpdate = true; pavement.invalidateReflection(); return true;
    },
    applyAuthoritativeBoxes: next => {
      if (mode !== "idle" || disposed) return false;
      const byId = new Map(next.map(box => [box.id, box]));
      for (const [id, cube] of cubes) {
        prizeBatch.proxies.attach(cube); const box = byId.get(id); cube.visible = !!box; cube.scale.setScalar(1);
        if (box) { cube.position.set(box.center.x, box.center.y, box.center.z); cube.quaternion.set(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w); }
      }
      boxes = [...next]; poseBoxes = null; pickupFrames = null; transport = null; prizeBatch.sync(); stations?.sync(boxes); light.shadow.needsUpdate = true; return true;
    },
    cancelDrop: () => { if (mode === "prepared") { mode = "idle"; pull = null; picked = null; gripPlan = null; gripOrigin = null; dx = dz = 0; } },
    setView: (next) => { view = next; room.setTopView(next === "top"); cabinet.setTopView(next === "top"); canvas.setAttribute("aria-label", `3D CATO arcade claw machine, ${next === "top" ? "top" : "front"} view`); resize(); },
    setTheme: (theme) => { if (mode === "idle") { cabinet.setTheme(theme); } },
    setConfig: (nextTier, nextOverrides, nextDebug, nextCurrency) => { if (mode === "idle") {
      tier = nextTier; overrides = nextOverrides; debug = nextDebug; paymentCurrency = nextCurrency;
      if (Number.isInteger(nextTier) && nextTier >= 0 && nextTier < 3 && stationTier !== nextTier) {
        // Station panning preserves the current wallet zoom.
        stationTier = nextTier; cameraTargetX = STATION_X[nextTier]; scene.position.x = cameraTargetX;
        if (warming) { camera.position.x += cameraTargetX - cameraX; cameraX = cameraTargetX; }
        scene.updateMatrixWorld(true); cabinet.setFinish(nextTier); cabinet.setStationOffset(cameraTargetX); stations?.sync(boxes); stations?.select(nextTier);
        light.shadow.needsUpdate = true; pavement.invalidateReflection();
        canvas.setAttribute("aria-label", `${STATION_NAMES[nextTier]} token claw machine, ${view} view`);
      }
    } },
    resetPile: () => { if (mode !== "idle") return; pickupFrames = null; transport = null; boxes = [...initialBoxes]; prizeBatch.reset(); stations?.sync(boxes); light.shadow.needsUpdate = true; },
    dispose: () => {
      motionFeedback?.stop();
      if (insertion) { insertion.reject(new Error("Token insertion interrupted")); insertion = null; }
      disposed = true; loop.dispose(); observer.disconnect(); document.removeEventListener("visibilitychange", visibility);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
      world.traverse((object) => { if (object instanceof THREE.Mesh || object instanceof THREE.Line) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) => materials.add(m)); } });
      prizeBatch.dispose(); stations?.dispose(); pavement.disposeReflection();
      geometries.forEach((g) => g.dispose()); materials.forEach((m) => { Object.values(m).forEach(value => { if (value instanceof THREE.Texture) textures.add(value); }); m.dispose(); }); textures.forEach((t) => t.dispose()); disposeEnvironment(); light.shadow.map?.dispose(); light.shadow.mapPass?.dispose(); if (renderer) { renderer.dispose(); renderer.forceContextLoss(); } canvas.remove(); diagnosticPanel?.remove();
    },
    performance: performanceMetrics,
  };
}
