import * as THREE from "three";

export const MACHINE_FONT_FAMILY = "CATO Pixel Sans Serif";
let pendingFont: Promise<void> | null = null;

/** Load before creating canvas textures; a later font load cannot repaint them. */
export function loadMachineFont(): Promise<void> {
  if (!pendingFont) {
    pendingFont = new FontFace(MACHINE_FONT_FAMILY, 'url("/claw/fonts/pixel-sans-serif.ttf")', { weight: "400", style: "normal" })
      .load().then((font) => { document.fonts.add(font); });
  }
  return pendingFont;
}

/** The marquee's LED colour, the arcade's amber. */
export const LED_AMBER = "#FEA911";
/** The marquee board is a matrix of LEDs: 81 across, 9 high (7 for the letters and a dark row above and below). */
export const LED_COLUMNS = 81, LED_ROWS = 9;
const LED_CELL = 12;

/** The classic 5 x 7 LED-sign alphabet ("#" is a lit LED). */
const LED_FONT: Readonly<Record<string, readonly string[]>> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"], B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."], D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"], F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"], H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."], J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"], L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"], N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"], R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."], T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."], X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."], Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."], 1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"], 3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."], 5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."], 7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."], 9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  "!": ["#", "#", "#", "#", "#", ".", "#"], ".": [".", ".", ".", ".", ".", ".", "#"], ":": [".", "#", ".", ".", ".", "#", "."],
  "-": ["...", "...", "...", "###", "...", "...", "..."], "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
};

/** Which LEDs of the marquee matrix light for `text`, centred; a letter outside the alphabet shows as a gap. */
export function ledMatrix(text: string, columns = LED_COLUMNS, rows = LED_ROWS) {
  const glyphs = [...text.toUpperCase()].map(char => LED_FONT[char] ?? null);
  const widths = glyphs.map(glyph => glyph ? glyph[0].length : 3);
  const width = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, glyphs.length - 1);
  const lit = Array.from({ length: rows }, () => new Array<boolean>(columns).fill(false));
  const top = Math.floor((rows - 7) / 2);
  let x = Math.floor((columns - width) / 2);
  glyphs.forEach((glyph, index) => {
    glyph?.forEach((row, r) => [...row].forEach((cell, c) => { if (cell === "#" && x + c >= 0 && x + c < columns) lit[top + r][x + c] = true; }));
    x += widths[index] + 1;
  });
  return { lit, width, columns, rows };
}

function rgba(hex: string, alpha: number, mixWith?: string, amount = 0) {
  const channels = (value: string) => { const n = parseInt(value.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const [r, g, b] = channels(hex), [mr, mg, mb] = mixWith ? channels(mixWith) : [r, g, b];
  const mix = (from: number, to: number) => Math.round(from + (to - from) * amount);
  return `rgba(${mix(r, mr)},${mix(g, mg)},${mix(b, mb)},${alpha})`;
}

/**
 * The marquee message as a glowing LED matrix: every LED faintly visible on the dark board, the lit ones in
 * the given colour (the arcade's amber unless a result says otherwise) with a hot core and a soft glow round them.
 */
export function ledMatrixTexture(text: string, color = LED_AMBER): THREE.CanvasTexture {
  const { lit, columns, rows } = ledMatrix(text);
  const canvas = document.createElement("canvas"); canvas.width = columns * LED_CELL; canvas.height = rows * LED_CELL;
  const context = canvas.getContext("2d");
  if (context && typeof context.arc === "function") {
    const dots = (on: boolean, radius: number) => {
      context.beginPath();
      for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
        if (lit[r][c] !== on) continue;
        const cx = (c + .5) * LED_CELL, cy = (r + .5) * LED_CELL;
        context.moveTo(cx + radius, cy); context.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    };
    dots(false, LED_CELL * .3); context.fillStyle = rgba(color, .09); context.fill();
    dots(true, LED_CELL * .42);
    context.shadowColor = rgba(color, .9); context.shadowBlur = LED_CELL * 1.5; context.fillStyle = rgba(color, .5); context.fill();
    context.shadowBlur = 0; context.fillStyle = rgba(color, 1); context.fill();
    dots(true, LED_CELL * .2); context.fillStyle = rgba(color, 1, "#FFEDCD", .6); context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

export function pixelTexture(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
  const font = `64px "${MACHINE_FONT_FAMILY}"`;
  context.font = font;
  const metrics = context.measureText(text), padding = 4;
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || 64);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || 0);
  canvas.width = Math.ceil(metrics.width) + padding * 2;
  canvas.height = ascent + descent + padding * 2;
  context.font = font; context.fillStyle = color; context.imageSmoothingEnabled = false;
  context.fillText(text, padding, padding + ascent);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
