import * as THREE from "three";
import { MACHINE_FONT_FAMILY } from "./machineTypography";

export const NEON_AMBER = "#FEA911";
export const NEON_EMBER = "#D3601E";
export const NEON_CREAM = "#FFEDCD";

/** Two quick flickers, a short stutter, then a steady glow. [ms since power-on, level]. */
export const NEON_POWER_ON: readonly (readonly [number, number])[] = [
  [0, .85], [70, 0], [170, .55], [225, .04], [420, 1], [480, .35], [540, 1],
];
export const NEON_POWER_ON_MS = 640;
/** The signs come on one after another down the row, this far apart. */
export const NEON_STAGGER_MS = 150;

/** The sign hangs in the strip of wall the station framing shows between the canopy and the frame's top edge. */
export const NEON_SIGN_HEIGHT = 1.47;
/** Canvas size, and the clear margin kept round the tubes for the ember falloff (the widest tube stroke is 24px). */
const CANVAS_WIDTH = 2048, CANVAS_HEIGHT = 352, GLOW_MARGIN = 150, WIDEST_STROKE = 24;
export const NEON_SIGN_WIDTH = NEON_SIGN_HEIGHT * CANVAS_WIDTH / CANVAS_HEIGHT;
/** The box the tubes themselves can reach, centred on the sign; only the soft glow lies outside it. */
export const NEON_SIGN_TUBES = Object.freeze({
  width: NEON_SIGN_WIDTH * (CANVAS_WIDTH - GLOW_MARGIN + WIDEST_STROKE) / CANVAS_WIDTH,
  height: NEON_SIGN_HEIGHT * (CANVAS_HEIGHT - GLOW_MARGIN + WIDEST_STROKE) / CANVAS_HEIGHT,
});

/** Light level of the sign `elapsed` ms after it powered on; steady at once under reduced motion. */
export function neonPowerLevel(elapsed: number, reducedMotion = false) {
  if (reducedMotion || elapsed >= NEON_POWER_ON_MS) return 1;
  if (!(elapsed >= 0)) return 0;
  let level = 0;
  for (const [at, value] of NEON_POWER_ON) if (elapsed >= at) level = value;
  // The final step warms up over the last 100 ms instead of switching like a lamp.
  return elapsed >= 540 ? THREE.MathUtils.lerp(.82, 1, (elapsed - 540) / 100) : level;
}

type Stroke = (context: CanvasRenderingContext2D) => void;

/** A cat-head outline traced as one bent tube: ears, cheeks and two short whisker pairs. */
function catHead(cx: number, cy: number, r: number): Stroke {
  return context => {
    context.beginPath();
    context.moveTo(cx - r * .92, cy + r * .08);
    context.lineTo(cx - r * .80, cy - r * 1.02);
    context.lineTo(cx - r * .30, cy - r * .62);
    context.quadraticCurveTo(cx, cy - r * .74, cx + r * .30, cy - r * .62);
    context.lineTo(cx + r * .80, cy - r * 1.02);
    context.lineTo(cx + r * .92, cy + r * .08);
    context.bezierCurveTo(cx + r * .98, cy + r * .78, cx + r * .42, cy + r * .96, cx, cy + r * .96);
    context.bezierCurveTo(cx - r * .42, cy + r * .96, cx - r * .98, cy + r * .78, cx - r * .92, cy + r * .08);
    context.closePath(); context.stroke();
    for (const side of [-1, 1]) {
      // Eyes as short slanted dashes, whiskers as two strokes each side.
      context.beginPath(); context.moveTo(cx + side * r * .48, cy - r * .06); context.lineTo(cx + side * r * .22, cy + r * .06); context.stroke();
      for (const [from, to] of [[.36, .20], [.54, .66]]) {
        context.beginPath(); context.moveTo(cx + side * r * .34, cy + r * from); context.lineTo(cx + side * r * 1.2, cy + r * to); context.stroke();
      }
    }
  };
}

/** One wide line of tubes: the cat head, then CATO ARCADE, sized to fill the strip with room for the glow. */
function signCanvas(lit: boolean) {
  const canvas = document.createElement("canvas"); canvas.width = CANVAS_WIDTH; canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context || typeof context.stroke !== "function") return canvas;
  const font = `200px "${MACHINE_FONT_FAMILY}", "Courier New", monospace`, text = "CATO ARCADE";
  context.font = font; context.lineJoin = "round"; context.lineCap = "round"; context.textBaseline = "alphabetic";
  const metrics = context.measureText(text), textWidth = metrics.width || 1500;
  const capHeight = (metrics.actualBoundingBoxAscent || 140) + (metrics.actualBoundingBoxDescent || 0);
  const headRadius = capHeight * .56, gap = capHeight * .42, headWidth = headRadius * 2.6;
  const width = headWidth + gap + textWidth, height = Math.max(headRadius * 2.05, capHeight);
  // Keep clear margins for the ember falloff so no glow is clipped by the canvas edge.
  const scale = Math.min((CANVAS_WIDTH - GLOW_MARGIN) / width, (CANVAS_HEIGHT - GLOW_MARGIN) / height);
  context.translate((CANVAS_WIDTH - width * scale) / 2, CANVAS_HEIGHT / 2); context.scale(scale, scale);
  const baseline = capHeight / 2 - (metrics.actualBoundingBoxDescent || 0);
  const shapes: Stroke[] = [catHead(headWidth / 2, headRadius * .03, headRadius), c => { c.strokeText(text, headWidth + gap, baseline); }];
  const pass = (style: string, lineWidth: number, blur = 0, glow = "transparent") => {
    context.strokeStyle = style; context.lineWidth = lineWidth; context.shadowBlur = blur; context.shadowColor = glow;
    shapes.forEach(shape => shape(context));
  };
  if (lit) {
    // Wide ember falloff, the amber tube, then a cream-hot core: how real neon reads on camera.
    pass("rgba(211,96,30,.55)", 24, 46, NEON_EMBER);
    pass("rgba(254,169,17,.9)", 14, 22, NEON_AMBER);
    pass(NEON_AMBER, 8.5, 7, NEON_AMBER);
    pass(NEON_CREAM, 3.4);
  } else {
    // Unlit glass tubes: dull smoked amber with a faint top highlight, readable before power-on.
    pass("#2a1a0e", 11); pass("#4a3020", 5.5); pass("rgba(255,237,205,.10)", 2);
  }
  return canvas;
}

function canvasTexture(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
  return texture;
}

/**
 * One "CATO ARCADE" neon over every station. All signs share one plane and the two canvas textures;
 * each keeps its own lit layer so they can power on one after another down the row.
 */
export function createNeonSigns(stations: readonly number[]) {
  const geometry = new THREE.PlaneGeometry(NEON_SIGN_WIDTH, NEON_SIGN_HEIGHT);
  const tubesMaterial = new THREE.MeshBasicMaterial({ map: canvasTexture(signCanvas(false)), transparent: true, depthWrite: false, fog: false });
  const litTexture = canvasTexture(signCanvas(true));
  const signs = stations.map(x => {
    const group = new THREE.Group(); group.name = "CATO ARCADE neon sign"; group.position.x = x;
    const tubes = new THREE.Mesh(geometry, tubesMaterial); tubes.name = "Unlit neon tubes";
    const glowMaterial = new THREE.MeshBasicMaterial({ map: litTexture, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: false, opacity: 0 });
    const glow = new THREE.Mesh(geometry, glowMaterial); glow.name = "Lit neon tubes"; glow.position.z = .004; glow.renderOrder = 2; glow.visible = false;
    // Never culled, so priming covers every pass (the screen and the floor reflection) whatever is in view.
    glow.frustumCulled = false;
    group.add(tubes, glow);
    return { x, group, glow, glowMaterial, delay: 0, level: 0 };
  });
  let poweredAt: number | null = null, steady = false;
  return {
    signs,
    /** Current light output of each sign, 0..1, for the wall light it casts. */
    get levels() { return signs.map(sign => sign.level); },
    /** The player's own sign lights first, then the others down the row, NEON_STAGGER_MS apart. */
    powerOn(now: number, reducedMotion = false, fromX = stations[0] ?? 0) {
      if (poweredAt !== null) return;
      poweredAt = now; steady = reducedMotion;
      [...signs].sort((a, b) => Math.abs(a.x - fromX) - Math.abs(b.x - fromX) || a.x - b.x)
        .forEach((sign, rank) => { sign.delay = rank * NEON_STAGGER_MS; });
    },
    update(now: number, reducedMotion = false) {
      let lit = 0;
      for (const sign of signs) {
        const next = poweredAt === null ? 0 : steady || reducedMotion ? 1 : neonPowerLevel(now - poweredAt - sign.delay);
        sign.level = next; sign.glowMaterial.opacity = next; sign.glow.visible = next > .001;
        if (next >= 1) lit++;
      }
      if (lit === signs.length) steady = true;
    },
    /** Show every lit layer for one render while it is still dark (zero opacity; the next update hides it again), so the
     * startup render uploads its texture and compiles its shaders, not the frame where a sign lights up mid-flight. */
    prime() { for (const sign of signs) sign.glow.visible = true; },
  };
}
export type NeonSigns = ReturnType<typeof createNeonSigns>;
