# FaceTime Plumbing Estimator — Beta Multi-Model Hackathon (Oct 23, 2026)

A homeowner FaceTimes a Chert number. The AI agent **sees** the broken fixture through their camera, **reads** the model label, **searches** the live part price with Keenable, builds a priced quote with **plain code** (the model never does math), and texts the contractor an **approve link** over iMessage. Every line of the quote carries a receipt: a source URL and the camera snapshot it came from. Anything without a live source is marked **Unverified**.

Modalities: live video (caller camera) · voice (OpenAI Realtime) · image-to-text (label OCR via vision model) · web search (Keenable) · iMessage (Chert).

## Layout

```
quote-agent/
  agent.mjs         LiveKit/Chert agent: realtime voice + tools
  vision.mjs        caller camera capture → JPEG → vision model
  face.mjs          the face the caller sees, with a live status line
  keenable.mjs      live part-price search (keyless fallback built in)
  estimator.mjs     deterministic quote math from pricebook.json
  pricebook.json    plumbing jobs, hours, contractor rate/markup/trip fee
  quote-server.mjs  quote page with receipts + contractor approve/edit link
  chert-sms.mjs     iMessage via Chert Messaging API (dry-runs without a secret)
  scripts/render-face.mjs  preview the face as a JPEG
```

## Run (three terminals, all in `quote-agent/`)

Node 24 is required (Node 25 is rejected by Chert). It is installed keg-only:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd ~/Beta\ Fund\ Project/quote-agent
```

1. Fill `.env.local` (see table). Then:
2. **Terminal 1** – quote web server: `npm run web` → http://localhost:3000
3. **Terminal 2** – agent: `npm start`
4. **Terminal 3** – put it on the line: `chert login` (once), `chert doctor`, then `chert dev`
5. FaceTime **Video** the line. The agent greets when `chert dev` prints "FaceTime is ready".

For phones to open quote links, expose the server and set `PUBLIC_URL` (e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`), then restart `npm run web` and `npm start`.

After any code change, restart terminals 2 and 3 (a waiting room can hold old code).

Only one computer can hold the line: `chert dev` on a second machine with the same account displaces the first. Agree which machine runs the demo.

**Caller video on FaceTime:** Chert has not enabled caller-camera capture on the hackathon lines yet (the bridge publishes only `facetime-remote-audio`). The agent already subscribes to `facetime-remote-video`; until Chert enables it, a call with no video switches to voice (Quill asks for the brand and model number aloud). To show camera vision now, run `scripts/phone-link.sh`: it puts the agent in a LiveKit room and copies a link that opens a camera + mic call in a phone browser.

## `.env.local`

| Key | Needed for | Where |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the call | LiveKit Cloud → project → Settings → API keys (all three from one project) |
| `OPENAI_API_KEY` | voice (Realtime) | OpenAI key with Realtime access and credits. Empty = pipeline voice (below). A new account without billing stops at 50 Realtime sessions a day |
| `ANTHROPIC_API_KEY` | vision + pipeline brain | Claude reads the camera when set; with `OPENAI_API_KEY` empty, Claude (`claude-opus-5-5`) also runs the conversation over LiveKit Inference speech (STT/TTS billed to the LiveKit project) |
| `ELEVEN_API_KEY`, `ELEVEN_VOICE_ID` | optional | ElevenLabs voice for the pipeline mode |
| `AGENT_NAME` | Chert routing | already `quote-agent`; must be unique across teams |
| `CONTRACTOR_PHONE` | approve-link iMessage | teammate's iPhone, E.164 |
| `HOMEOWNER_PHONE` | approved-quote iMessage | demo homeowner's iPhone (agent also asks on the call) |
| `CHERT_SIGNING_SECRET` | iMessage | Chert console → API keys → Reveal. Empty = dry-run (logs only, approve link still works) |
| `KEENABLE_API_KEY` | optional | redeem BETA200 at keenable.ai. Empty = keyless `/public` endpoint (tested, works) |
| `VISION_MODEL` / `VISION_BASE_URL` / `VISION_API_KEY` | optional | defaults to OpenAI `gpt-5-mini`. For Nebius: base `https://api.studio.nebius.com/v1`, a Qwen-VL model, Nebius key |
| `CONTRACTOR_NAME`, `CONTRACTOR_RATE` | optional | overrides pricebook.json |
| `PUBLIC_URL` | links in texts | tunnel URL when phones need to open the quote |

## Quick checks without a call

```sh
npm run check                                   # syntax of every module
npm run estimate -- faucet_cartridge_replace 26.46 "Moen 1225" https://shop.moen.com/products/1225
npm run search -- "Moen 1225 cartridge"         # live Keenable price search
npm run render-face -- /tmp/face.jpg "LOOKING..."
```

## Demo script (≈ 2 minutes)

1. Homeowner FaceTimes the line. Quill answers: "point the camera at the problem."
2. Homeowner shows the dripping faucet, says "it drips." Agent: "let me take a look" → status line shows **LOOKING...** → "I see a single-handle kitchen faucet dripping at the spout. How long?"
3. Homeowner holds up the cartridge/label. Agent reads **MODEL 1225**.
4. "Checking today's price" → Keenable → **PART $26.46** (moen.com).
5. **QUOTE $174** → agent reads the total, asks for the homeowner's number.
6. Contractor's phone buzzes with the iMessage → taps Approve on the approve page (can edit hours first).
7. Homeowner's phone gets the approved quote text. Open the quote page: snapshots, per-line receipts, Unverified badges, trace log.

Record this on the first clean run. Use the recording on slide 2; go live only if time remains.

## Fallback if caller video is not forwarded by the Chert bridge

Check on the very first call: `[camera] subscribed to caller video` must appear in terminal 2. If it never does:

- The agent already handles it: `look_at_camera` returns an error and tells the homeowner no video is coming through.
- Switch the flow to **voice + iMessage photo**: homeowner texts a photo of the fixture and label to the Chert number; a teammate (or a small script on Chert's `/api/v1/events/stream`) saves it and POSTs it to `/api/quote/:id/snapshot`, then calls the vision prompts in `vision.mjs` on it. Everything downstream (search, quote, approval) is unchanged.
- Still multimodal: voice, image, web search, iMessage. Still qualifies for the Chert prize (voice agent on FaceTime + iMessage).

## Submission reminders

- Hard deadline **4:45 PM PT**, Master Deck locks. Exactly 3 slides: Who / What + demo (video ≤ 2 min or screenshot + live URL) / Why us.
- Chert prize: post repo + LinkedIn/X post + <2 min live-call video in the Chert Discord.
- Judging: Multi-Modal Depth · Technical Execution · Usefulness · Shipability · Demo Clarity.
