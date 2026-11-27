/* eslint-disable react/no-unknown-property -- react-three-fiber JSX (args, position, intensity, object) */
// The roaming cat: glb + toon look, mixer with weight blending, the brain, cursor head tracking, and the orthographic
// camera that follows it. The cat lives on the page's platforms (the panel top edges the overlay measures, the ground
// at the viewport bottom, and its home, the spot's floor): the follow-canvas tracks its feet, up ledges and through
// leaps. The on-screen hit area is kept in sync for the overlay's hitbox. Ported from cato-3d's CatModel, plus the
// mood / platform integration.
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { catMoodFor, type CatPose } from '../game/cat-pose';
import { CatBrain, CLIPS, type BrainOutput, type CatClip, type HomeSpot } from './brain';
import { platformsToMetres, type KeepOutRect, type PlatformPx } from './platforms';
import { addOutline, setOutlineWidth, toonify } from './toon';

export interface CatInputs {
  hovered: boolean;
  clicked: boolean;
  pointer: { x: number; y: number } | null; // viewport px
  pointerMovedAt: number; // performance.now() ms
  pointerKind: string; // 'mouse' | 'pen' | 'touch' | ''
  viewport: { w: number; h: number }; // page viewport in CSS px
  reducedMotion: boolean;
  commands: CatClip[];
  /** the page's platforms in viewport px (ground last), from the overlay's DOM sweep */
  platforms: PlatformPx[];
  /** the page's keep-out zones (viewport px): the hitbox lets pointer events through while it covers one */
  keepOut: KeepOutRect[];
  /** the pointer dragging the cat (viewport px), null when he is not being carried */
  drag: { x: number; y: number } | null;
  pose: CatPose;
  /** set when `pose` changed and the brain has not reacted yet */
  poseChanged: boolean;
}

interface CatExtras {
  walkSpeed: number;
  runSpeed: number;
  height: number;
  jump: { takeoff: number; land: number; distance: number };
  pounce: { takeoff: number; land: number; distance: number };
}

interface Props {
  src: string;
  size: number; // cat height in px
  inputs: MutableRefObject<CatInputs>;
  hitbox: MutableRefObject<HTMLDivElement | null>;
  /** the small canvas wrapper that follows the cat around the page */
  stage: MutableRefObject<HTMLDivElement | null>;
  /** called once, after the first rendered frame */
  onReady?: () => void;
}

const TILT = THREE.MathUtils.degToRad(12);
const GROUND_MARGIN_PX = 6;
/** metres kept clear of the viewport's left/right edges */
export const ROAM_MARGIN_M = 0.16;
/** seconds to wait for a home platform before the cat appears elsewhere (the play screen is a lazy route) */
const ANCHOR_WAIT_S = 2;
/** walk a touch faster than the glb's pace; the Walk clip plays faster by the same factor so the feet don't slide */
export const WALK_BOOST = 1.5;
/** a resting cursor is only pounce-worthy this close (in cat heights) to the cat's floor */
const POUNCE_REACH = 1.5;
const FADE = 0.25;
const TRACKED = ['neck', 'head', 'eye_L', 'eye_R'];
const FACE_VIEWER = new Set<CatClip>(['Swat', 'Wave', 'Purr', 'Yawn', 'Sit', 'SitIdle', 'Groom']);
// bone name -> radius (m) used to build the on-screen hit area
const HIT_BONES: [string, number][] = [
  ['head', 0.14], ['ear_L_tip', 0.02], ['ear_R_tip', 0.02], ['hips', 0.08], ['chest', 0.08],
  ['front_L_toes', 0.03], ['front_R_toes', 0.03], ['back_L_toes', 0.03], ['back_R_toes', 0.03], ['tail_07', 0.035],
];

export default function CatModel({ src, size, inputs, hitbox, stage, onReady }: Props) {
  const gltf = useGLTF(src);
  // `view` is the follow-canvas (a few cat-widths wide), not the page
  const { camera, size: view, raycaster, gl } = useThree();
  const group = useRef<THREE.Group>(null!);

  const extras = (gltf.scene.userData.cato ?? {}) as CatExtras;
  const catHeight = extras.height || 0.48;
  const k = size / catHeight; // px per metre

  const { scene, outlines, bones, rest } = useMemo(() => {
    const scene = cloneSkinned(gltf.scene) as THREE.Group;
    const skinned = toonify(scene, gl.capabilities.getMaxAnisotropy());
    const outlines = skinned.map((m) => addOutline(m, 2 / k));
    const bones: Record<string, THREE.Bone> = {};
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
    });
    // rest rotations of the bones we steer procedurally; restored every frame before the mixer runs
    const rest = TRACKED.filter((n) => bones[n]).map((n) => [bones[n], bones[n].quaternion.clone()] as const);
    return { scene, outlines, bones, rest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf]);

  useEffect(() => outlines.forEach((h) => setOutlineWidth(h, 2.2 / k)), [k, outlines]);

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actions = useMemo(() => {
    const map = {} as Record<CatClip, THREE.AnimationAction>;
    for (const clip of gltf.animations) map[clip.name as CatClip] = mixer.clipAction(clip);
    return map;
  }, [gltf, mixer]);

  const brain = useRef<CatBrain | null>(null);
  const state = useRef({
    seq: -1, current: null as THREE.AnimationAction | null, yaw: 0, look: new THREE.Vector2(), trackW: 0,
    out: null as BrainOutput | null, lastClip: '', ready: false, floorY: NaN, waited: 0, lastPlatform: '',
    weights: new Map<THREE.AnimationAction, number>(),
    /** carrying: the cat's feet relative to the pointer (px) at pick-up, so he doesn't jump into the hand */
    grab: null as { dx: number; dy: number } | null,
  });

  // orthographic camera: k px per metre, ground at the canvas bottom, slight top-down tilt.
  // It follows the cat every frame (see the frame loop).
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.zoom = k;
    cam.near = 0.1;
    cam.far = 50;
    cam.updateProjectionMatrix();
  }, [camera, k, view.width, view.height]);

  useEffect(() => () => {
    mixer.stopAllAction();
  }, [mixer]);

  // free the materials we created (geometry/textures belong to the shared useGLTF cache)
  useEffect(() => () => {
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && (o as THREE.Mesh).isMesh) m.dispose();
    });
  }, [scene]);

  const tmp = useMemo(() => ({
    v: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), pq: new THREE.Quaternion(),
    e: new THREE.Euler(), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.45), hit: new THREE.Vector3(),
    ndc: new THREE.Vector2(), head: new THREE.Vector3(), inv: new THREE.Quaternion(),
  }), []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const inp = inputs.current;
    const page = inp.viewport;
    const s = state.current;
    const halfW = page.w / 2 / k;
    const bounds = { min: -halfW + ROAM_MARGIN_M, max: Math.max(-halfW + ROAM_MARGIN_M, halfW - ROAM_MARGIN_M) };
    const toWorld = (px: number) => (px - page.w / 2) / k;

    // the world: the page's platforms in metres (the overlay sweeps the DOM; the ground is always last)
    const platforms = platformsToMetres(inp.platforms, page, k);
    const home = platforms.find((p) => p.home) ?? null;

    if (!brain.current) {
      // the spot is on a lazy route: give it a moment to appear, so the cat can start there (where the picture was)
      s.waited += dt;
      if (!home && s.waited < ANCHOR_WAIT_S) return;
      const durations = {} as Record<CatClip, number>;
      for (const c of CLIPS) durations[c] = actions[c]?.getClip().duration ?? 1;
      // start on the spot when the page has one (the picture was there), else towards the right of the viewport
      brain.current = new CatBrain({
        x: home ? (home.x0 + home.x1) / 2 : inp.reducedMotion ? bounds.max - 0.05 : bounds.min + (bounds.max - bounds.min) * 0.7,
        y: home ? home.y : 0, platform: home ? home.id : undefined,
        durations, walkSpeed: (extras.walkSpeed ?? 0.22) * WALK_BOOST, runSpeed: extras.runSpeed ?? 0.62,
        jump: extras.jump ?? { takeoff: 0.4, land: 0.93, distance: 0.35 },
        pounce: extras.pounce ?? { takeoff: 0.67, land: 1, distance: 0.3 },
      });
      actions.Walk?.setEffectiveTimeScale(WALK_BOOST);
      inp.poseChanged = false;
    }
    const b = brain.current;
    if (inp.commands.length) b.command(...inp.commands.splice(0));

    // --- the mood: where to be and what to do there
    const mood = catMoodFor(inp.pose);
    if (inp.poseChanged) {
      inp.poseChanged = false;
      if (mood.enter?.length) b.visitHome(...mood.enter);
      else b.settle();
    }
    let hold: HomeSpot | null = null;
    if (mood.where !== 'roam' && mood.loop) hold = { loop: mood.loop, extras: mood.extras, here: mood.where === 'here' };

    // --- picked up / dropped: the feet follow the pointer, keeping their offset from where he was grabbed
    if (inp.drag && !s.grab) {
      const feetX = page.w / 2 + (s.out?.x ?? 0) * k;
      const feetY = Number.isFinite(s.floorY) ? s.floorY : page.h;
      s.grab = { dx: feetX - inp.drag.x, dy: feetY - inp.drag.y };
      b.pickUp();
    } else if (!inp.drag && s.grab) {
      s.grab = null;
      b.drop();
    }
    if (inp.drag && s.grab) {
      const fx = inp.drag.x + s.grab.dx;
      const fy = Math.min(page.h, inp.drag.y + s.grab.dy);
      b.hold(toWorld(fx), (page.h - fy) / k);
    }

    let pointerX = inp.pointer ? toWorld(inp.pointer.x) : null;
    if (pointerX !== null && inp.pointer && Math.abs(inp.pointer.y - s.floorY) > size * POUNCE_REACH) pointerX = null;
    const out = b.update({
      dt, hovered: inp.hovered, clicked: inp.clicked, pointerX,
      pointerIdle: (performance.now() - inp.pointerMovedAt) / 1000,
      bounds, reducedMotion: inp.reducedMotion, home: hold, sleepAfter: mood.sleepAfter, platforms,
    });
    inp.clicked = false;
    s.out = out;

    // --- clip switching: blend weights from wherever they are (no pops on quick changes)
    if (out.seq !== s.seq) {
      s.seq = out.seq;
      const next = actions[out.clip];
      if (next) {
        const weight = s.weights.get(next) ?? 0;
        // restart one-shots; keep a loop that is still (partly) playing so it doesn't snap to frame 0
        if (!out.loop || weight < 0.05 || !next.isRunning()) next.reset();
        next.setLoop(out.loop ? THREE.LoopRepeat : THREE.LoopOnce, out.loop ? Infinity : 1);
        next.clampWhenFinished = !out.loop;
        next.play();
        s.current = next;
      }
    }
    for (const a of Object.values(actions)) {
      const w0 = s.weights.get(a) ?? 0;
      const target = a === s.current ? 1 : 0;
      if (w0 === target && target === 0) continue;
      const w = target > w0 ? Math.min(target, w0 + dt / FADE) : Math.max(target, w0 - dt / FADE);
      s.weights.set(a, w);
      a.setEffectiveWeight(w);
      if (w === 0) a.stop();
    }

    // --- placement & facing
    const g = group.current;
    g.position.x = out.x;
    let targetYaw = out.facing * (out.moving ? 1.25 : 0.4);
    if (FACE_VIEWER.has(out.clip)) targetYaw = out.facing * 0.12;
    if (out.held) targetYaw = out.facing * 0.12;
    s.yaw = THREE.MathUtils.damp(s.yaw, targetYaw, out.moving ? 10 : 5, dt);
    g.rotation.y = s.yaw;
    // carried: a slight dangling sway
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, out.held ? Math.sin(performance.now() * 0.004) * 0.12 : 0, 6, dt);
    g.position.y = out.purr && out.sleeping ? Math.sin(performance.now() * 0.09) * 0.0012 : 0;

    // tracking is layered on top of the clip, so start each frame from rest (never accumulate)
    for (const [bone, q] of rest) bone.quaternion.copy(q);
    mixer.update(dt);

    // --- the floor: wherever the brain says the feet are (a platform, the ground, or mid-leap between them)
    s.floorY = page.h - out.y * k;

    // --- the canvas follows the cat: camera centred on it, wrapper moved to match (page x = W/2 + x*k)
    const left = page.w / 2 + out.x * k - view.width / 2;
    const top = s.floorY + GROUND_MARGIN_PX - view.height;
    const cam = camera as THREE.OrthographicCamera;
    const yt = (view.height / 2 - GROUND_MARGIN_PX) / (k * Math.cos(TILT));
    cam.position.set(out.x, yt + Math.sin(TILT) * 10, Math.cos(TILT) * 10);
    cam.lookAt(out.x, yt, 0);
    cam.updateMatrixWorld();
    if (stage.current) stage.current.style.transform = `translate3d(${left.toFixed(2)}px, ${top.toFixed(2)}px, 0)`;

    // --- head & eyes follow the cursor (layered on top of the clip)
    const wantTrack = out.track && inp.pointer ? 1 : 0;
    s.trackW = THREE.MathUtils.damp(s.trackW, wantTrack, 4, dt);
    if (inp.pointer && bones.head) {
      tmp.ndc.set(((inp.pointer.x - left) / view.width) * 2 - 1, -((inp.pointer.y - top) / view.height) * 2 + 1);
      raycaster.setFromCamera(tmp.ndc, camera);
      if (raycaster.ray.intersectPlane(tmp.plane, tmp.hit)) {
        g.updateMatrixWorld(true);
        bones.head.getWorldPosition(tmp.head);
        tmp.head.y += 0.06;
        const d = tmp.hit.sub(tmp.head);
        tmp.inv.copy(g.quaternion).invert();
        d.applyQuaternion(tmp.inv);
        // limits keep the face readable: a big tilt up shows the chin, a big turn shows the side of the head
        const yaw = THREE.MathUtils.clamp(Math.atan2(d.x, d.z), -0.8, 0.8);
        const pitch = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -0.3, 0.26);
        s.look.x = THREE.MathUtils.damp(s.look.x, yaw, 6, dt);
        s.look.y = THREE.MathUtils.damp(s.look.y, pitch, 6, dt);
      }
    }
    if (s.trackW > 0.001) {
      const w = s.trackW;
      rotateInGroupSpace(bones.neck, g, s.look.y * 0.35 * w, s.look.x * 0.35 * w, tmp);
      rotateInGroupSpace(bones.head, g, s.look.y * 0.65 * w, s.look.x * 0.65 * w, tmp);
      for (const eye of [bones.eye_L, bones.eye_R]) {
        rotateInGroupSpace(eye, g, THREE.MathUtils.clamp(s.look.y, -0.3, 0.3) * 0.35 * w,
          THREE.MathUtils.clamp(s.look.x, -0.5, 0.5) * 0.3 * w, tmp);
      }
    }

    // --- hit area follows the cat on screen
    const el = hitbox.current;
    if (el) {
      g.updateMatrixWorld(true);
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const [name, r] of HIT_BONES) {
        const bone = bones[name];
        if (!bone) continue;
        bone.getWorldPosition(tmp.v).project(camera);
        const px = left + (tmp.v.x + 1) / 2 * view.width;
        const py = top + (1 - tmp.v.y) / 2 * view.height;
        const rp = r * k;
        x0 = Math.min(x0, px - rp); x1 = Math.max(x1, px + rp);
        y0 = Math.min(y0, py - rp); y1 = Math.max(y1, py + rp);
      }
      // belt and braces: over a keep-out zone (a button) the hitbox must not intercept the page's clicks
      const overKeepOut = Number.isFinite(x0) && inp.keepOut.some((r) => x0 < r.right && x1 > r.left && y0 < r.bottom && y1 > r.top);
      if (Number.isFinite(x0) && inp.pointer && inp.pointerKind === 'mouse') {
        // the cat can walk under (or away from) a resting cursor without any pointer events firing
        const { x, y } = inp.pointer;
        inp.hovered = !overKeepOut && x >= x0 && x <= x1 && y >= y0 && y <= y1;
      }
      if (Number.isFinite(x0)) {
        el.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
        el.style.width = `${(x1 - x0).toFixed(1)}px`;
        el.style.height = `${(y1 - y0).toFixed(1)}px`;
        // carried, the hitbox lets events through too: the overlay follows the dragging pointer window-wide
        const pe = overKeepOut || out.held ? 'none' : 'auto';
        if (el.style.pointerEvents !== pe) el.style.pointerEvents = pe;
        el.dataset.keepout = String(overKeepOut);
        el.dataset.held = String(out.held);
      }
      if (s.lastClip !== out.clip) {
        s.lastClip = out.clip;
        el.dataset.clip = out.clip;
      }
      el.dataset.sleeping = String(out.sleeping);
      el.dataset.home = String(out.atHome);
      el.dataset.airborne = String(out.airborne);
      el.dataset.feetY = s.floorY.toFixed(1);
      if (s.lastPlatform !== out.platform) {
        s.lastPlatform = out.platform;
        el.dataset.platform = out.platform;
      }
    }
    if (!s.ready) {
      s.ready = true;
      onReady?.();
    }
  });

  return (
    <group ref={group}>
      <primitive object={scene} />
    </group>
  );
}

/** Apply pitch (up +) and yaw (cat's left/right) to a bone, expressed in the cat group's frame. */
function rotateInGroupSpace(
  bone: THREE.Bone | undefined, g: THREE.Object3D, pitch: number, yaw: number,
  tmp: { q: THREE.Quaternion; q2: THREE.Quaternion; pq: THREE.Quaternion; e: THREE.Euler },
) {
  if (!bone || !bone.parent) return;
  bone.updateWorldMatrix(true, false);
  // delta in group space, then in world space
  tmp.e.set(-pitch, yaw, 0, 'YXZ');
  tmp.q.setFromEuler(tmp.e);
  g.getWorldQuaternion(tmp.q2);
  tmp.q.premultiply(tmp.q2).multiply(tmp.q2.invert()); // gq * delta * gq^-1
  bone.getWorldQuaternion(tmp.q2);
  tmp.q2.premultiply(tmp.q); // new world rotation
  bone.parent.getWorldQuaternion(tmp.pq);
  bone.quaternion.copy(tmp.pq.invert().multiply(tmp.q2));
  bone.updateMatrixWorld(true);
}
