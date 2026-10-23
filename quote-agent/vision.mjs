// Caller camera capture + vision model calls.
//
// The LiveKit JS SDK does not feed the caller's video into the realtime model by itself, so we
// subscribe to the caller's camera track, keep the latest frame, and on demand JPEG-encode it and
// send it to a vision model (OpenAI by default; any OpenAI-compatible endpoint via VISION_BASE_URL).
import { RoomEvent, TrackKind, VideoBufferType, VideoStream } from '@livekit/rtc-node';
import jpeg from 'jpeg-js';

export class CallerCamera {
  /** @param {import('@livekit/rtc-node').Room} room @param {string} callerIdentity */
  constructor(room, callerIdentity) {
    this.room = room;
    this.identity = callerIdentity;
    this.latest = null;
    this.latestAt = 0;
    this.rotation = 0;
    this.frames = 0;
    this._stopped = false;
    this._onSub = (track, _pub, participant) => {
      if (participant?.identity === this.identity && track.kind === TrackKind.KIND_VIDEO) this._consume(track);
    };
  }

  start() {
    this.room.on(RoomEvent.TrackSubscribed, this._onSub);
    const p = this.room.remoteParticipants.get(this.identity);
    if (p) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track && pub.track.kind === TrackKind.KIND_VIDEO) this._consume(pub.track);
      }
    }
  }

  stop() {
    this._stopped = true;
    this.room.off(RoomEvent.TrackSubscribed, this._onSub);
  }

  async _consume(track) {
    console.log('[camera] subscribed to caller video');
    const stream = new VideoStream(track);
    try {
      for await (const ev of stream) {
        if (this._stopped) break;
        this.latest = ev.frame;
        this.rotation = Number(ev.rotation) || 0;
        this.latestAt = Date.now();
        this.frames++;
      }
    } catch (e) {
      console.warn('[camera] stream ended:', e?.message || e);
    }
  }

  get hasFrame() {
    return Boolean(this.latest) && Date.now() - this.latestAt < 5000;
  }

  /** JPEG of the latest frame, upright and no larger than maxSide pixels. */
  snapshot({ maxSide = 896, quality = 72 } = {}) {
    if (!this.latest) return null;
    let f = this.latest;
    if (f.type !== VideoBufferType.RGBA) f = f.convert(VideoBufferType.RGBA);
    let img = { data: f.data, width: f.width, height: f.height };
    // VideoRotation: 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270° (clockwise to display upright).
    for (let i = 0; i < (this.rotation % 4); i++) img = rotate90(img);
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (scale < 1) img = downscale(img, scale);
    const out = jpeg.encode({ data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height }, quality);
    return { buffer: out.data, width: img.width, height: img.height, dataUrl: `data:image/jpeg;base64,${out.data.toString('base64')}` };
  }
}

function rotate90({ data, width, height }) {
  const out = new Uint8Array(data.length);
  const W = height, H = width; // new dimensions
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = height - 1 - y, dy = x;
      const s = (y * width + x) * 4, d = (dy * W + dx) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: W, height: H };
}

function downscale({ data, width, height }, scale) {
  const W = Math.max(1, Math.round(width * scale)), H = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const s = (sy * width + sx) * 4, d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/** Ask a vision model about one image. Returns the model's text. */
export async function askVision({ dataUrl, prompt, system }) {
  const base = (process.env.VISION_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const key = process.env.VISION_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.VISION_MODEL || 'gpt-5-mini';
  if (!key) throw new Error('No VISION_API_KEY or OPENAI_API_KEY set');
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }] });
  const body = { model, messages };
  if (/^(gpt-5|o\d)/.test(model)) { body.max_completion_tokens = 2000; body.reasoning_effort = 'low'; }
  else { body.max_tokens = 700; body.temperature = 0.2; }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

/** Lenient JSON extraction from a model reply. */
export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

export const IDENTIFY_PROMPT = (homeownerSaid, jobTypes) => `You are a licensed plumber looking through a homeowner's phone camera on a video call.
The homeowner says the problem is: "${homeownerSaid || 'not stated'}".
Look at the image and answer ONLY with JSON, no prose:
{
  "fixture": "what fixture/part is shown (e.g. single-handle kitchen faucet, toilet tank, P-trap under sink)",
  "brand_guess": "brand if any logo/shape suggests it, else null",
  "visible_problem": "what is visibly wrong, in one sentence",
  "likely_job_type": "one of: ${jobTypes.join(', ')}",
  "severity": "low | medium | high",
  "mismatch": true or false (true if what you see does not match what the homeowner said),
  "mismatch_note": "why, or empty string",
  "safety_flags": ["only from: exposed wiring, gas smell indicators, sewage, active flooding, mold, scalding risk"],
  "confidence": 0.0 to 1.0,
  "notes": "anything the estimator should know, one sentence"
}
If the image is too dark, blurry or shows no plumbing, set fixture to "unclear" and confidence below 0.3.`;

export const LABEL_PROMPT = `You are reading a manufacturer label, model plate, or stamped marking on a plumbing fixture or part, through a phone camera.
Answer ONLY with JSON, no prose:
{
  "readable": true or false,
  "brand": "brand name or null",
  "model_number": "exact model/part number as printed, or null",
  "other_text": "other useful text (series, finish, date code), or empty string",
  "confidence": 0.0 to 1.0,
  "advice": "if not readable: one short instruction for the homeowner (closer, more light, hold still), else empty string"
}
Transcribe characters exactly; do not guess digits you cannot see.`;
