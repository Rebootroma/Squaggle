// The picture your caller sees: one RGBA frame per call to drawFace. Plain JavaScript, no dependencies.
// Shows an animated face plus a live status line ("LOOKING...", "QUOTE $184") so the homeowner can
// follow what the agent is doing.
export const WIDTH = 640;
export const HEIGHT = 360;
export const FPS = 15;

const BACKGROUND = [16, 40, 52], FACE = [141, 224, 196], INK = [16, 40, 52], ACCENT = [255, 200, 118], TEXT = [236, 246, 242], DIM = [120, 160, 150];

// 5x7 bitmap font. '#' = lit pixel.
const GLYPHS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####', J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  $: '..#..|.####|#.#..|.###.|..#.#|####.|..#..', '.': '.....|.....|.....|.....|.....|.##..|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....', '-': '.....|.....|.....|#####|.....|.....|.....',
  '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##', "'": '.##..|..#..|.#...|.....|.....|.....|.....',
  '/': '....#|...#.|...#.|..#..|.#...|.#...|#....', ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..', '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};
for (const k of Object.keys(GLYPHS)) GLYPHS[k] = GLYPHS[k].split('|');

function put(pixels, x, y, color) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
}

/** Draw text (uppercased) at x,y with a pixel scale. Unknown characters become spaces. */
export function drawText(pixels, text, x, y, scale, color) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r][c] !== '#') continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(pixels, cx + c * scale + dx, y + r * scale + dy, color);
    }
    cx += 6 * scale;
  }
}

export function textWidth(text, scale) { return String(text).length * 6 * scale - scale; }

/**
 * @param {number} tick       frame counter
 * @param {boolean} speaking  true while the agent talks (opens the mouth)
 * @param {string} [status]   short status line shown under the face
 * @param {string} [title]    small caption at the top
 */
export function drawFace(tick, speaking, status = '', title = 'AI PLUMBING ESTIMATOR') {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  const cx = WIDTH / 2, cy = HEIGHT / 2 - 30, radius = HEIGHT * 0.30;
  const blink = tick % 60 < 3;
  const mouth = speaking ? 6 + 14 * Math.abs(Math.sin(tick * 0.8)) : 4;
  const bar = (tick * 6) % (WIDTH - 40);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let color = BACKGROUND;
      if ((x - cx) ** 2 + (y - cy) ** 2 < radius ** 2) color = FACE;
      const eye = Math.abs(x - (cx - 38)) < 9 || Math.abs(x - (cx + 38)) < 9;
      if (eye && Math.abs(y - (cy - 30)) < (blink ? 2 : 12)) color = INK;
      if (((x - cx) / 40) ** 2 + ((y - (cy + 38)) / mouth) ** 2 < 1) color = INK;
      if (y > HEIGHT - 16 && y < HEIGHT - 8 && x > bar && x < bar + 40) color = ACCENT;
      const i = (y * WIDTH + x) * 4;
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
    }
  }
  if (title) drawText(pixels, title, Math.round((WIDTH - textWidth(title, 2)) / 2), 14, 2, DIM);
  if (status) {
    const s = String(status).slice(0, 34);
    const scale = 3;
    const w = textWidth(s, scale);
    drawText(pixels, s, Math.round((WIDTH - w) / 2), HEIGHT - 62, scale, speaking ? TEXT : ACCENT);
  }
  return pixels;
}
