// FaceTime plumbing estimator agent. Answers the Chert line, looks through the homeowner's camera,
// reads the model label, searches the live part price, builds a receipt-backed quote with plain code,
// and texts the contractor an approve link.
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { CallerCamera, askVision, IDENTIFY_PROMPT, LABEL_PROMPT, parseJson } from './vision.mjs';
import { searchPartPrice } from './keenable.mjs';
import { buildQuote, loadPricebook } from './estimator.mjs';
import { sendIMessage } from './chert-sms.mjs';

const book = loadPricebook();
const JOB_KEYS = Object.keys(book.jobs);
const AGENT_PERSONA = 'Quill';
const QUOTE_SERVER_URL = (process.env.QUOTE_SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');

const instructions = `You are "${AGENT_PERSONA}", an AI plumbing estimator on a FaceTime video call for ${book.contractor.name}. Be clear that you are an AI.
You can SEE through the homeowner's camera only by calling tools (look_at_camera, read_label). Never claim to see something you did not get from a tool.
Keep every reply to one or two short, natural sentences. Call one tool at a time. Say a short phrase like "one moment" before slow tools.

Flow:
1. Ask the homeowner to point the camera at the problem and say what is wrong. When they do, say "let me take a look" and call look_at_camera with their description.
2. Tell them what you see in one sentence. If the tool reports mismatch=true, say plainly that what you see differs from what they described, and ask which is right. Ask ONE clarifying question (how long, where exactly is the leak, is the water shut off).
3. If safety_flags is not empty (exposed wiring, gas, sewage, active flooding, scalding risk): call safety_stop, tell them to stop, shut off water or power if safe, and call a licensed emergency plumber. Do not quote.
4. Ask them to hold the model label or plate close to the camera and hold still, then call read_label. If readable=false, repeat the tool's advice once and try read_label once more. If still unreadable, continue with the brand guess and fixture type.
5. Say "checking today's price" and call search_part_price with brand + model number + part name, e.g. "Moen 1225 cartridge". If no model number, use brand + fixture + part type.
6. Call build_quote with the best matching job_type, the part name, and the price and source_url from the search's best result. If the search found no price, omit part_price and part_source_url. Never do arithmetic yourself; read the total the tool returns.
7. Tell them the total in one sentence and that each line has a receipt they can check on the link. If you do not have their mobile number, ask for the best number to text the final quote to, then call set_homeowner_phone with it in E.164 form (+1...).
8. Call send_to_contractor. Tell them ${book.contractor.name} will review and approve it and they will get a text with the final quote. Say goodbye warmly.

Rules: never invent prices, brands or model numbers; if a tool returns ok=false, tell the homeowner what to do (hold steady, more light, closer) and try once more; if the homeowner asks for something outside plumbing, say you only handle plumbing today.`;

const greeting = `Greet the caller in one short sentence: say you are ${AGENT_PERSONA}, the AI estimator for ${book.contractor.name}, and ask them to point the camera at the plumbing problem and tell you what is wrong.`;

export default defineAgent({
  entry: async ctx => {
    // Subscribe to everything so the caller's camera track reaches us.
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    const caller = await ctx.waitForParticipant();
    console.log(`[call] caller joined: ${caller.identity} room=${ctx.room.name}`);

    // ---- Agent video: a drawn face with a live status line ----
    let status = '';
    const setStatus = s => { status = s || ''; console.log(`[status] ${status}`); };
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false;
    const frame = () => source.captureFrame(new VideoFrame(drawFace(tick++, speaking, status), WIDTH, HEIGHT, VideoBufferType.RGBA));
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);

    // ---- Caller camera ----
    const camera = new CallerCamera(ctx.room, caller.identity);
    camera.start();

    // ---- Per-call state + quote server client ----
    const state = {
      quoteId: null, quoteUrl: null, approveUrl: null,
      vision: null, label: null, search: null, estimate: null,
      homeownerPhone: process.env.HOMEOWNER_PHONE || null,
      status: 'in_progress',
    };
    async function qs(method, path, body) {
      try {
        const r = await fetch(QUOTE_SERVER_URL + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        return await r.json();
      } catch (e) { console.warn(`[quote-server] ${method} ${path} failed: ${e.message}`); return null; }
    }
    async function ensureQuote() {
      if (state.quoteId) return;
      const q = await qs('POST', '/api/quote', { homeowner_phone: state.homeownerPhone, call_id: ctx.room.name });
      if (q?.id) { state.quoteId = q.id; state.quoteUrl = q.url; state.approveUrl = q.approve_url; console.log(`[quote] ${q.url}`); }
    }
    async function patch(fields) { await ensureQuote(); if (state.quoteId) return qs('PATCH', `/api/quote/${state.quoteId}`, fields); }
    async function trace(type, text, data) {
      console.log(`[trace] ${type}: ${text}`);
      await ensureQuote();
      if (state.quoteId) qs('POST', `/api/quote/${state.quoteId}/event`, { type, text, data });
    }
    async function captureSnapshot(label) {
      const snap = camera.snapshot();
      if (!snap) return null;
      await ensureQuote();
      const r = state.quoteId ? await qs('POST', `/api/quote/${state.quoteId}/snapshot`, { dataUrl: snap.dataUrl, label }) : null;
      return { ...snap, url: r?.url || null };
    }
    const fail = (error, advice) => ({ ok: false, error, advice });
    const NO_VIDEO = 'No video from the caller yet. Ask them to point the camera at the problem, hold steady for two seconds, and try again.';

    ensureQuote();

    // ---- Tools ----
    const tools = {
      look_at_camera: llm.tool({
        description: "Look through the homeowner's camera right now and identify the fixture and the visible problem. Call this as soon as the homeowner says they are showing you something.",
        parameters: z.object({ homeowner_description: z.string().describe("What the homeowner said the problem is, in their words") }),
        execute: async ({ homeowner_description }) => {
          try {
            setStatus('LOOKING...');
            if (!camera.hasFrame) { await trace('vision', `No camera frame (frames so far: ${camera.frames})`); setStatus('NEED CAMERA'); return fail('no_video', NO_VIDEO); }
            const snap = await captureSnapshot('Fixture');
            const text = await askVision({ dataUrl: snap.dataUrl, prompt: IDENTIFY_PROMPT(homeowner_description, JOB_KEYS) });
            const result = parseJson(text) || { fixture: 'unclear', visible_problem: text.slice(0, 200), confidence: 0.2, safety_flags: [], mismatch: false };
            result.safety_flags = Array.isArray(result.safety_flags) ? result.safety_flags : [];
            state.vision = { ...result, snapshot_url: snap.url };
            await patch({ vision: state.vision, problem_summary: homeowner_description, mismatch: Boolean(result.mismatch), safety_flags: result.safety_flags });
            await trace('vision', `Saw: ${result.fixture} — ${result.visible_problem}${result.mismatch ? ' (MISMATCH with homeowner description)' : ''}`, result);
            setStatus(result.safety_flags.length ? 'SAFETY CHECK' : `SAW: ${String(result.fixture || '').slice(0, 26)}`);
            return { ok: true, ...result, snapshot_url: snap.url };
          } catch (e) {
            await trace('error', `look_at_camera: ${e.message}`); setStatus('');
            return fail(e.message, 'Say you could not get a clear look and ask them to hold the camera steady with more light, then try again.');
          }
        },
      }),

      read_label: llm.tool({
        description: "Read the manufacturer label or model plate the homeowner is holding up to the camera. Call after asking them to hold it close and still.",
        execute: async () => {
          try {
            setStatus('READING LABEL...');
            if (!camera.hasFrame) { setStatus('NEED CAMERA'); return fail('no_video', NO_VIDEO); }
            const snap = await captureSnapshot('Model label');
            const text = await askVision({ dataUrl: snap.dataUrl, prompt: LABEL_PROMPT });
            const result = parseJson(text) || { readable: false, brand: null, model_number: null, advice: 'Hold the label closer and still.', confidence: 0 };
            state.label = { ...result, snapshot_url: snap.url };
            await patch({ label: state.label });
            await trace('label', result.readable ? `Label: ${result.brand || '?'} ${result.model_number || '?'}` : `Label unreadable: ${result.advice || ''}`, result);
            setStatus(result.readable && result.model_number ? `MODEL ${String(result.model_number).slice(0, 20)}` : 'LABEL UNCLEAR');
            return { ok: true, ...result, snapshot_url: snap.url };
          } catch (e) {
            await trace('error', `read_label: ${e.message}`); setStatus('');
            return fail(e.message, 'Ask them to hold the label closer with more light and try once more.');
          }
        },
      }),

      search_part_price: llm.tool({
        description: "Search the live web (Keenable) for the current price of a replacement part. Pass brand + model number + part name.",
        parameters: z.object({ part_query: z.string().describe('e.g. "Moen 1225 cartridge" or "Kohler toilet fill valve"') }),
        execute: async ({ part_query }) => {
          try {
            setStatus('SEARCHING PRICE...');
            const r = await searchPartPrice(part_query);
            state.search = r;
            await patch({ search: { query: r.query, best: r.best, candidates: r.candidates, keyed: r.keyed } });
            await trace('search', r.best ? `Keenable: ${r.best.title} — $${r.best.price} (${r.best.url})` : `Keenable: ${r.result_count} results, no price found`, { query: r.query, best: r.best, endpoint: r.endpoint });
            setStatus(r.best ? `PART $${r.best.price.toFixed(2)}` : 'NO PRICE FOUND');
            if (!r.best) return { ok: true, found: false, query: r.query, result_count: r.result_count, advice: 'No live price found. Call build_quote without part_price; the price book default will be used and marked unverified.' };
            return { ok: true, found: true, query: r.query, best: { title: r.best.title, price: r.best.price, url: r.best.url, snippet: r.best.snippet }, other_candidates: r.candidates.slice(1, 3).map(c => ({ price: c.price, url: c.url })) };
          } catch (e) {
            await trace('error', `search_part_price: ${e.message}`); setStatus('');
            return fail(e.message, 'Say the price lookup is slow and call build_quote without a part_price so the quote still gets built.');
          }
        },
      }),

      build_quote: llm.tool({
        description: "Build the priced quote with plain code from the contractor's price book. Call once you know the job type and have searched for the part price.",
        parameters: z.object({
          job_type: z.enum(JOB_KEYS).describe('Closest job in the price book'),
          part_name: z.string().optional().describe('Human-readable part name, e.g. "Moen 1225 cartridge"'),
          part_price: z.number().optional().describe('Price from search_part_price best result; omit if none'),
          part_source_url: z.string().optional().describe('URL from search_part_price best result; omit if none'),
          problem_summary: z.string().describe('One sentence describing the problem for the quote'),
        }),
        execute: async ({ job_type, part_name, part_price, part_source_url, problem_summary }) => {
          try {
            setStatus('BUILDING QUOTE...');
            const verified = Boolean(part_price && part_source_url);
            const parts = part_name ? [{ name: part_name, price: part_price, source_url: part_source_url, verified, snapshot_url: state.label?.snapshot_url || state.vision?.snapshot_url || null }] : [];
            const est = buildQuote({ jobType: job_type, parts, book });
            state.estimate = est; state.status = 'awaiting_approval';
            await patch({ estimate: est, parts_input: parts, status: 'awaiting_approval', problem_summary });
            await trace('quote', `Quote built: ${est.job_label} — $${est.total.toFixed(2)} (${est.unverified_count} unverified)`, { total: est.total, lines: est.lines.length });
            setStatus(`QUOTE $${est.total.toFixed(0)}`);
            return {
              ok: true, total: est.total, currency: est.currency, job_label: est.job_label, hours: est.hours,
              lines: est.lines.map(l => ({ label: l.label, amount: l.amount, verified: l.verified })),
              unverified_count: est.unverified_count, quote_url: state.quoteUrl,
              next: 'Tell the homeowner the total in one sentence, ask for their mobile number if unknown, then call send_to_contractor.',
            };
          } catch (e) {
            await trace('error', `build_quote: ${e.message}`); setStatus('');
            return fail(e.message, e.code === 'unknown_job' ? `Pick one of: ${JOB_KEYS.join(', ')}` : 'Try again with the same inputs.');
          }
        },
      }),

      set_homeowner_phone: llm.tool({
        description: "Save the homeowner's mobile number so the final approved quote can be texted to them.",
        parameters: z.object({ phone: z.string().describe('E.164, e.g. +14155551234') }),
        execute: async ({ phone }) => {
          const digits = phone.replace(/[^\d+]/g, '');
          const e164 = digits.startsWith('+') ? digits : (digits.length === 10 ? `+1${digits}` : `+${digits}`);
          state.homeownerPhone = e164;
          await patch({ homeowner_phone: e164 });
          await trace('phone', `Homeowner phone saved: ${e164}`);
          return { ok: true, phone: e164 };
        },
      }),

      send_to_contractor: llm.tool({
        description: "Text the contractor an iMessage with the quote total and an approve/edit link. Call after build_quote.",
        execute: async () => {
          try {
            const est = state.estimate;
            if (!est) return fail('no_quote', 'Call build_quote first.');
            setStatus('TEXTING CONTRACTOR...');
            const phone = process.env.CONTRACTOR_PHONE;
            const s = est.unverified_count === 1 ? '' : 's';
            const body = `${book.contractor.name}: new quote request. ${est.job_label} — $${est.total.toFixed(2)} (${est.unverified_count} unverified line${s}). Approve or edit: ${state.approveUrl || state.quoteUrl || '(quote server offline)'}`;
            const r = await sendIMessage(phone, body);
            await trace('imessage', r.ok ? `Contractor texted at ${phone}${r.dry_run ? ' (dry run)' : ''}` : `Contractor text failed: ${JSON.stringify(r.error)}`, r);
            setStatus(r.ok ? 'SENT TO CONTRACTOR' : 'TEXT FAILED');
            if (!r.ok && !phone) return { ok: true, sent: false, note: 'CONTRACTOR_PHONE is not set; the approve link is still live.', approve_url: state.approveUrl };
            return { ok: true, sent: r.ok, dry_run: Boolean(r.dry_run), approve_url: state.approveUrl, quote_url: state.quoteUrl };
          } catch (e) {
            await trace('error', `send_to_contractor: ${e.message}`); setStatus('');
            return fail(e.message, 'Tell the homeowner the quote is saved and the contractor will review it shortly.');
          }
        },
      }),

      safety_stop: llm.tool({
        description: 'Stop the estimate because of a safety hazard (exposed wiring, gas, sewage, active flooding, scalding). Records the reason.',
        parameters: z.object({ reason: z.string() }),
        execute: async ({ reason }) => {
          state.status = 'safety_stop';
          setStatus('STOP - SAFETY');
          await patch({ status: 'safety_stop', safety_flags: [reason] });
          await trace('safety', `Safety stop: ${reason}`);
          return { ok: true, advice: 'Tell the homeowner to stop, shut off the water (and power if safe) and call a licensed emergency plumber or 911 for gas. Do not give a price.' };
        },
      }),
    };

    // ---- Realtime session ----
    const session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({ model: process.env.REALTIME_MODEL || 'gpt-realtime', voice: process.env.REALTIME_VOICE || 'marin' }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });

    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
      camera.stop();
      if (state.status === 'in_progress' && state.quoteId) await qs('PATCH', `/api/quote/${state.quoteId}`, { status: 'call_ended' });
      await session.close();
      await track.close();
      await source.close();
    });

    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions, tools }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false, // we handle the caller's video ourselves (CallerCamera)
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });

    const stopGreeting = greetOnBridgeReady(ctx.room, () => { setStatus('HI! SHOW ME THE PROBLEM'); session.generateReply({ instructions: greeting }); });
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'quote-agent',
}));
