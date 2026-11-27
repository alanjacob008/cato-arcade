import * as THREE from "three";
import { type IntroPose } from "./introCamera";

export const WALLET_ZOOM_MS = 1600;

/** Continuous acceleration and a soft stop, without the cubic curve's midpoint jolt. */
export function walletZoomEase(t: number) {
  const v = THREE.MathUtils.clamp(t, 0, 1);
  return v * v * v * (v * (v * 6 - 15) + 10);
}

/** Presentation only. Camera travel never authorizes a wallet or changes a play. */
export function createWalletCamera(camera: THREE.Camera, power: (on: boolean) => void) {
  let connected = false, wide: IntroPose | null = null, close: IntroPose | null = null;
  let flight: { from: IntroPose; to: IntroPose; elapsed: number; duration: number } | null = null;
  const pose = (): IntroPose => ({ position: camera.position.clone(), quaternion: camera.quaternion.clone() });
  function place(target: IntroPose) {
    // Station panning owns X; the dolly only changes framing and orientation.
    const x = camera.position.x;
    camera.position.copy(target.position); camera.position.x = x;
    camera.quaternion.copy(target.quaternion); camera.updateMatrixWorld();
  }
  function finish() {
    const target = connected ? close : wide;
    if (target) place(target);
    flight = null; power(connected && !!close);
  }
  return {
    get state() { return !wide ? "pending" : flight ? "flying" : connected ? "done" : "holding"; },
    get flight() { return flight; },
    setFraming(nextWide: IntroPose, nextClose: IntroPose, reducedMotion: boolean, previous = pose()) {
      wide = nextWide; close = nextClose;
      if (flight && !reducedMotion) {
        flight = { from: previous, to: connected ? close : wide, elapsed: 0, duration: Math.max(150, flight.duration - flight.elapsed) };
        place(previous);
      } else { place(connected ? close : wide); if (reducedMotion && flight) finish(); }
    },
    setConnected(value: boolean, reducedMotion: boolean) {
      if (connected === value) return;
      connected = value; power(false);
      const target = connected ? close : wide;
      if (!target) return;
      if (reducedMotion) finish();
      else flight = { from: pose(), to: target, elapsed: 0, duration: WALLET_ZOOM_MS };
    },
    frame(dt: number, visible: boolean) {
      if (!flight || !visible) return;
      flight.elapsed += Math.min(.1, Math.max(0, dt)) * 1000;
      const t = Math.min(1, flight.elapsed / flight.duration), eased = walletZoomEase(t);
      const position = flight.from.position.clone().lerp(flight.to.position, eased);
      const quaternion = flight.from.quaternion.clone().slerp(flight.to.quaternion, eased);
      place({ position, quaternion });
      if (t === 1) finish();
    },
    land() { if (connected && flight) finish(); },
  };
}
