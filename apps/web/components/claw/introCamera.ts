import * as THREE from "three";

/** The first-visit fly-in from the wide establishing shot to the player's station. */
export const INTRO_DURATION_MS = 2500;
/** An input during the fly-in settles the camera into place this fast instead of snapping. */
export const INTRO_SETTLE_MS = 420;
/** The player's sign starts to power on this far into the fly-in, so the lights come on while the camera moves. */
export const SIGN_POWER_DELAY_MS = 300;
/** Sent on `window` by the arcade's loading screen as it begins to lift: the cue for the fly-in. */
export const ARCADE_REVEAL_EVENT = "cato:arcade-reveal";
/** Without that cue, the held opening shot starts to fly this long after the first render. */
export const INTRO_REVEAL_FALLBACK_MS = 4000;
/** A frame later than this (a shader compile, a busy main thread) pauses the flight by the excess instead of skipping it. */
export const INTRO_MAX_FRAME_GAP_MS = 100;

/** Travel curve, cubic-bezier(.65,0,.35,1)-like: no overshoot, no bounce. */
export function introEase(t: number) {
  const v = THREE.MathUtils.clamp(t, 0, 1);
  return v < .5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}
export function settleEase(t: number) { const v = THREE.MathUtils.clamp(t, 0, 1); return 1 - (1 - v) ** 3; }

/** Farthest the opening shot stands back: the fog (from 35 units) never reaches the machine, its sign or the wall. */
export const ESTABLISHING_MAX_DISTANCE = 26.5;
/** How much further back than a tight fit the push-in starts, so the machine fills about half the frame. */
export const ESTABLISHING_PULLBACK = 1.45;
/** Half the width of a cabinet, canopy and base included. */
const CABINET_HALF_WIDTH = 1.7;

/**
 * The opening of the push-in: straight in front of the player's own machine, higher and further back, holding
 * the machine, its sign above it and the warm floor below. The fly-in then dollies straight in to the station
 * framing, the same move as the home page's hero film. A neighbouring station only shows if the frame reaches it
 * inside the fog; with stations 26 units apart it does not.
 */
export function establishingShot(aspect: number, fovDegrees: number, stationX: number, signTop: number, signHalfWidth = 2.1) {
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDegrees / 2)), safeAspect = Math.max(.2, aspect);
  const bottom = -1.9, top = signTop + .45, halfWidth = Math.max(CABINET_HALF_WIDTH, signHalfWidth) + .9;
  const fit = Math.max((top - bottom) / 2 / tanV, halfWidth / (tanV * safeAspect));
  const distance = THREE.MathUtils.clamp(fit * ESTABLISHING_PULLBACK, 12, ESTABLISHING_MAX_DISTANCE);
  // A little higher than the station framing's own line of sight, so the camera settles down onto the machine.
  const direction = new THREE.Vector3(0, .2, 1).normalize();
  const target = new THREE.Vector3(stationX, (top + bottom) / 2, -.4);
  return { position: target.clone().addScaledVector(direction, distance), target };
}

export type IntroPose = { position: THREE.Vector3; quaternion: THREE.Quaternion };
export type IntroFlight = { started: number; duration: number; ease: (t: number) => number; from: IntroPose; to: IntroPose };
/** Mirrored on the canvas as `data-intro` from the first ready frame: holding, then flying, then done; or skipped. */
export type IntroState = "pending" | "holding" | "flying" | "done" | "skipped";

/** Pose `camera` along the flight at `now`; returns true once it has landed on the station framing. */
export function applyIntroFlight(camera: THREE.Camera, flight: IntroFlight, now: number) {
  const t = flight.duration <= 0 ? 1 : (now - flight.started) / flight.duration, e = flight.ease(t);
  camera.position.lerpVectors(flight.from.position, flight.to.position, e);
  camera.quaternion.slerpQuaternions(flight.from.quaternion, flight.to.quaternion, e);
  camera.updateMatrixWorld();
  return t >= 1;
}

/**
 * The fly-in's timing. From the first ready frame the camera holds the opening shot. The push-in starts on a later,
 * visible frame: after the first render (shader compile, scene build) has finished, and once the loading screen has
 * begun to lift, or INTRO_REVEAL_FALLBACK_MS after that render without the cue. During the flight a late frame
 * pauses it and a hidden tab stops it, so neither can skip it.
 */
export function createIntroDirector(camera: THREE.Camera) {
  let state: IntroState = "pending", shot: { from: IntroPose; to: IntroPose } | null = null, flight: IntroFlight | null = null;
  let renderedAt: number | null = null, revealed = false, lastFrame: number | null = null;
  const pose = (): IntroPose => ({ position: camera.position.clone(), quaternion: camera.quaternion.clone() });
  const place = (target: IntroPose) => { camera.position.copy(target.position); camera.quaternion.copy(target.quaternion); camera.updateMatrixWorld(); };
  function fly(now: number, duration: number, ease: (t: number) => number, from: IntroPose, to: IntroPose) {
    flight = { started: now, duration, ease, from, to }; state = "flying"; applyIntroFlight(camera, flight, now);
  }
  return {
    get state() { return state; },
    /** The flight under way: the push-in, or a settle onto the station. */
    get flight() { return flight; },
    /** The first ready frame: take the opening shot and hold it. False when the fly-in was already skipped. */
    hold(from: IntroPose, to: IntroPose) {
      if (state !== "pending") return false;
      shot = { from, to }; state = "holding"; place(from); return true;
    },
    /** The first ready frame, without a fly-in. */
    skip() { if (state === "pending") state = "skipped"; },
    /** The first render has finished, at `at`; the fallback counts from here. */
    rendered(at: number) { if (renderedAt === null) renderedAt = at; },
    /** The loading screen has begun to lift. */
    reveal() { revealed = true; },
    /** A new opening shot and landing, for another stage size or station. */
    aim(from: IntroPose, to: IntroPose, now: number) {
      if (state === "holding") { shot = { from, to }; place(from); }
      else if (state === "flying" && flight) {
        flight.to = to; if (flight.duration === INTRO_DURATION_MS) flight.from = from;
        applyIntroFlight(camera, flight, now);
      }
    },
    /** One frame (`visible` is false in a hidden tab). True when the push-in starts or the flight lands. */
    frame(now: number, visible: boolean) {
      const gap = lastFrame === null ? 0 : Math.max(0, now - lastFrame); lastFrame = now;
      if (state === "holding") {
        const cued = revealed || (renderedAt !== null && now - renderedAt >= INTRO_REVEAL_FALLBACK_MS);
        if (!visible || renderedAt === null || now <= renderedAt || !cued) return false;
        fly(now, INTRO_DURATION_MS, introEase, shot!.from, shot!.to); return true;
      }
      if (state !== "flying" || !flight) return false;
      flight.started += visible ? Math.max(0, gap - INTRO_MAX_FRAME_GAP_MS) : gap;
      if (!applyIntroFlight(camera, flight, now)) return false;
      flight = null; state = "done"; return true;
    },
    /** Input: settle quickly onto the station from wherever the camera is. Before the first ready frame, skip the fly-in. */
    settle(now: number) {
      if (state === "pending") state = "skipped";
      else if (state === "holding") fly(now, INTRO_SETTLE_MS, settleEase, shot!.from, shot!.to);
      else if (state === "flying" && flight && flight.duration !== INTRO_SETTLE_MS) fly(now, INTRO_SETTLE_MS, settleEase, pose(), flight.to);
    },
    /** A play or a view change: land on the station at once (true when the camera moved). Before the first ready frame, skip. */
    land() {
      if (state === "pending") { state = "skipped"; return false; }
      if (state !== "holding" && state !== "flying") return false;
      place(flight?.to ?? shot!.to); flight = null; state = "done"; return true;
    },
  };
}

/** Orientation that looks from `position` at `target` with the world up axis. */
export function lookRotation(position: THREE.Vector3, target: THREE.Vector3) {
  const matrix = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}
