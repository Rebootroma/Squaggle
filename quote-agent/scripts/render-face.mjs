// Render one frame of the agent's face to a JPEG so it can be eyeballed without a call.
// node scripts/render-face.mjs [out.jpg] [status text]
import { writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { drawFace, HEIGHT, WIDTH } from '../face.mjs';

const out = process.argv[2] || 'face.jpg';
const status = process.argv[3] || 'QUOTE $184';
const pixels = drawFace(30, true, status);
const img = jpeg.encode({ data: Buffer.from(pixels.buffer), width: WIDTH, height: HEIGHT }, 90);
writeFileSync(out, img.data);
console.log(`wrote ${out} (${WIDTH}x${HEIGHT}, status "${status}")`);
