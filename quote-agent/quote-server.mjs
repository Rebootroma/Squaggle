// Quote web server: receives the quote from the agent, shows it to the homeowner with receipts,
// and gives the contractor an approve/edit link. Plain node:http, no framework.
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuote, loadPricebook } from './estimator.mjs';
import { sendIMessage } from './chert-sms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = join(here, 'data');
const SNAP_DIR = join(DATA_DIR, 'snapshots');
const DB = join(DATA_DIR, 'quotes.json');
mkdirSync(SNAP_DIR, { recursive: true });

let quotes = {};
try { if (existsSync(DB)) quotes = JSON.parse(readFileSync(DB, 'utf8')); } catch { quotes = {}; }
const save = () => { try { writeFileSync(DB, JSON.stringify(quotes, null, 2)); } catch (e) { console.warn('save failed', e.message); } };
const newId = () => randomBytes(3).toString('hex');
const now = () => new Date().toISOString();

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const json = (res, code, obj) => send(res, code, obj);
const html = (res, str, code = 200) => send(res, code, str, 'text/html; charset=utf-8');

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function publicView(q) {
  const { approve_token, ...rest } = q; // never leak the token to the homeowner page
  return rest;
}

function addEvent(q, type, text, data) {
  q.events.push({ at: now(), type, text, data: data ?? null });
  if (q.events.length > 200) q.events.shift();
}

async function notifyHomeowner(q) {
  if (!q.homeowner_phone) return { ok: false, error: 'no homeowner phone' };
  const total = q.estimate ? `$${q.estimate.total.toFixed(2)}` : 'see link';
  const body = `${q.contractor_name || 'Your contractor'} approved your quote: ${q.estimate?.job_label || 'repair'} for ${total}. Details and receipts: ${PUBLIC_URL}/q/${q.id}`;
  const r = await sendIMessage(q.homeowner_phone, body);
  addEvent(q, 'imessage', `Homeowner notified at ${q.homeowner_phone}${r.dry_run ? ' (dry run)' : ''}`, r);
  return r;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method;
  if (method === 'OPTIONS') return send(res, 204, '');

  try {
    // ---- API ----
    if (method === 'POST' && path === '/api/quote') {
      const b = await readBody(req);
      const id = newId();
      const book = loadPricebook();
      const q = {
        id, created_at: now(), status: 'in_progress',
        contractor_name: book.contractor.name,
        homeowner_phone: b.homeowner_phone || null,
        call_id: b.call_id || null,
        problem_summary: b.problem_summary || '',
        vision: null, label: null, search: null, estimate: null, parts_input: [],
        mismatch: false, safety_flags: [], snapshots: [], events: [],
        approve_token: randomBytes(8).toString('hex'),
      };
      addEvent(q, 'call', 'Call started; quote record created');
      quotes[id] = q; save();
      return json(res, 201, { id, url: `${PUBLIC_URL}/q/${id}`, approve_url: `${PUBLIC_URL}/approve/${id}?t=${q.approve_token}`, api_url: `${PUBLIC_URL}/api/quote/${id}` });
    }

    if (method === 'GET' && path === '/api/quotes') {
      const list = Object.values(quotes).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50)
        .map(q => ({ id: q.id, created_at: q.created_at, status: q.status, total: q.estimate?.total ?? null, job_label: q.estimate?.job_label ?? null, problem_summary: q.problem_summary }));
      return json(res, 200, list);
    }

    let m = path.match(/^\/api\/quote\/([a-z0-9]+)(?:\/(event|snapshot|approve))?$/);
    if (m) {
      const q = quotes[m[1]];
      if (!q) return json(res, 404, { error: 'not found' });
      const sub = m[2];
      if (!sub && method === 'GET') return json(res, 200, publicView(q));
      if (!sub && (method === 'PATCH' || method === 'PUT')) {
        const b = await readBody(req);
        const allowed = ['status', 'homeowner_phone', 'problem_summary', 'vision', 'label', 'search', 'estimate', 'parts_input', 'mismatch', 'safety_flags', 'contractor_name'];
        for (const k of allowed) if (k in b) q[k] = b[k];
        if (b.status) addEvent(q, 'status', `Status → ${b.status}`);
        q.updated_at = now(); save();
        return json(res, 200, publicView(q));
      }
      if (sub === 'event' && method === 'POST') {
        const b = await readBody(req);
        addEvent(q, b.type || 'note', b.text || '', b.data);
        save();
        return json(res, 200, { ok: true, count: q.events.length });
      }
      if (sub === 'snapshot' && method === 'POST') {
        const b = await readBody(req);
        const mm = String(b.dataUrl || '').match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
        if (!mm) return json(res, 400, { error: 'dataUrl must be a base64 image/jpeg or image/png' });
        const ext = mm[1] === 'png' ? 'png' : 'jpg';
        const file = `${q.id}-${q.snapshots.length + 1}.${ext}`;
        writeFileSync(join(SNAP_DIR, file), Buffer.from(mm[2], 'base64'));
        const snap = { url: `${PUBLIC_URL}/snap/${file}`, path: `/snap/${file}`, label: b.label || 'Snapshot', at: now() };
        q.snapshots.push(snap);
        addEvent(q, 'snapshot', `Captured: ${snap.label}`, { url: snap.url });
        save();
        return json(res, 201, snap);
      }
      if (sub === 'approve' && method === 'POST') {
        const b = await readBody(req);
        if (!b.token || b.token !== q.approve_token) return json(res, 403, { error: 'bad token' });
        if (b.action === 'edit') {
          if (!q.estimate) return json(res, 400, { error: 'no estimate yet' });
          const hours = Number(b.hours);
          const est = buildQuote({ jobType: q.estimate.job_type, parts: q.parts_input || [], hoursOverride: Number.isFinite(hours) && hours > 0 ? hours : undefined });
          q.estimate = est;
          addEvent(q, 'contractor', `Contractor edited labor to ${est.hours} h; new total $${est.total.toFixed(2)}${b.note ? ` — ${b.note}` : ''}`);
          q.updated_at = now(); save();
          return json(res, 200, publicView(q));
        }
        if (b.action === 'approve') {
          q.status = 'approved'; q.approved_at = now();
          addEvent(q, 'contractor', `Contractor approved${b.note ? `: ${b.note}` : ''}`);
          const r = await notifyHomeowner(q);
          save();
          return json(res, 200, { ...publicView(q), notify: r });
        }
        if (b.action === 'reject') {
          q.status = 'rejected';
          addEvent(q, 'contractor', `Contractor declined${b.note ? `: ${b.note}` : ''}`);
          save();
          return json(res, 200, publicView(q));
        }
        return json(res, 400, { error: 'action must be approve, edit or reject' });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    // ---- Files ----
    m = path.match(/^\/snap\/([a-z0-9-]+\.(jpg|png))$/);
    if (m && method === 'GET') {
      const p = join(SNAP_DIR, m[1]);
      if (!existsSync(p)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(p), m[2] === 'png' ? 'image/png' : 'image/jpeg');
    }

    // ---- Pages ----
    m = path.match(/^\/q\/([a-z0-9]+)$/);
    if (m && method === 'GET') return quotes[m[1]] ? html(res, page({ id: m[1], mode: 'homeowner' })) : html(res, notFound(), 404);
    m = path.match(/^\/approve\/([a-z0-9]+)$/);
    if (m && method === 'GET') {
      const q = quotes[m[1]];
      if (!q) return html(res, notFound(), 404);
      if (url.searchParams.get('t') !== q.approve_token) return html(res, notFound('That approval link is not valid.'), 403);
      return html(res, page({ id: m[1], mode: 'contractor', token: q.approve_token }));
    }
    if (path === '/' && method === 'GET') return html(res, indexPage());
    if (path === '/health') return json(res, 200, { ok: true, quotes: Object.keys(quotes).length });
    return html(res, notFound(), 404);
  } catch (e) {
    console.error(method, path, e);
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Quote server on http://localhost:${PORT}  (public: ${PUBLIC_URL})`));

// ---------- HTML ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#14202a;--muted:#5d6b78;--line:#e3e8ee;--accent:#0f766e;--accent-ink:#fff;--ok:#157347;--ok-bg:#e6f4ec;--warn:#9a5b00;--warn-bg:#fff4e0;--bad:#b42318;--bad-bg:#fde8e6;--radius:14px}
@media (prefers-color-scheme: dark){:root{--bg:#0e1419;--card:#161e26;--ink:#e8eef3;--muted:#9fb0bf;--line:#26323d;--accent:#2dd4bf;--accent-ink:#06201d;--ok:#4ade80;--ok-bg:#12301f;--warn:#fbbf24;--warn-bg:#3a2a07;--bad:#f87171;--bad-bg:#3b1413}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0 16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:14px}
.pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:600;white-space:nowrap}
.pill.progress{background:var(--warn-bg);color:var(--warn)}.pill.await{background:var(--warn-bg);color:var(--warn)}.pill.approved{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
table{width:100%;border-collapse:collapse}td,th{padding:10px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
td.amt,th.amt{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.receipt{font-size:13px;color:var(--muted);margin-top:4px}.receipt a{color:var(--accent);text-decoration:none}.receipt img{height:36px;border-radius:6px;vertical-align:middle;margin-left:6px;border:1px solid var(--line)}
.total td{font-weight:700;font-size:18px;border-bottom:none}
.snaps{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px}.snaps figure{margin:0;flex:0 0 auto}.snaps img{height:140px;border-radius:10px;border:1px solid var(--line);display:block}.snaps figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.muted{color:var(--muted)}.flag{padding:10px 12px;border-radius:10px;margin-bottom:10px;font-size:14px}.flag.warn{background:var(--warn-bg);color:var(--warn)}.flag.bad{background:var(--bad-bg);color:var(--bad)}
details summary{cursor:pointer;color:var(--muted);font-size:14px}.trace{list-style:none;padding:0;margin:10px 0 0;font-size:13px}.trace li{padding:6px 0;border-bottom:1px dashed var(--line)}.trace time{color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums}
button{appearance:none;border:0;border-radius:10px;padding:12px 18px;font-size:16px;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);width:100%}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);width:100%}
.row{display:flex;gap:10px;align-items:center}.row>*{flex:1}
.empty{padding:28px 10px;text-align:center;color:var(--muted)}
.list a{display:block;padding:12px 0;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}
`;

function page({ id, mode, token }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quote ${esc(id)}</title><style>${CSS}</style></head><body><div class="wrap">
<header><div><h1 id="title">Quote #${esc(id)}</h1><div class="muted" id="sub">Loading…</div></div><span class="pill progress" id="status">…</span></header>
<div id="flags"></div>
<div class="card" id="problem-card"><h2>Problem</h2><div id="problem" class="muted">Waiting for the call…</div></div>
<div class="card" id="snaps-card" hidden><h2>What the agent saw</h2><div class="snaps" id="snaps"></div></div>
<div class="card"><h2>Quote</h2><div id="lines" class="empty">The estimate appears here as soon as it is built.</div></div>
${mode === 'contractor' ? `<div class="card" id="ctl"><h2>Contractor</h2>
<div class="row" style="margin-bottom:10px"><input id="hours" type="number" step="0.25" min="0.25" placeholder="Labor hours"><button class="ghost" id="edit">Update hours</button></div>
<button class="primary" id="approve">Approve &amp; send to homeowner</button>
<div class="muted" id="ctl-msg" style="margin-top:8px;font-size:13px"></div></div>` : ''}
<div class="card"><details><summary>Trace log</summary><ul class="trace" id="trace"></ul></details></div>
<div class="muted" style="font-size:12px;text-align:center;padding:8px 0 24px">Prices come from live web search via Keenable. Labor and markup come from the contractor's price book. Lines marked Unverified have no live source.</div>
</div>
<script>
const ID=${JSON.stringify(id)}, MODE=${JSON.stringify(mode)}, TOKEN=${JSON.stringify(token || '')};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'$'+Number(n||0).toFixed(2);
const STATUS={in_progress:['On the call…','progress'],awaiting_approval:['Awaiting contractor approval','await'],approved:['Approved by contractor','approved'],rejected:['Declined by contractor','bad'],safety_stop:['Stopped: safety concern','bad'],call_ended:['Call ended','progress']};
function render(q){
  const [label,cls]=STATUS[q.status]||[q.status,'progress'];
  $('#status').textContent=label;$('#status').className='pill '+cls;
  $('#sub').textContent=(q.contractor_name||'')+(q.estimate?' · '+q.estimate.job_label:'');
  let flags='';
  if(q.safety_flags&&q.safety_flags.length)flags+='<div class="flag bad">⚠︎ Safety: '+esc(q.safety_flags.join(', '))+'. The agent stopped the estimate.</div>';
  if(q.mismatch)flags+='<div class="flag warn">What the homeowner described does not fully match what the camera showed'+(q.vision&&q.vision.mismatch_note?': '+esc(q.vision.mismatch_note):'')+'.</div>';
  if(q.estimate&&q.estimate.unverified_count)flags+='<div class="flag warn">'+q.estimate.unverified_count+' line'+(q.estimate.unverified_count>1?'s':'')+' could not be verified against a live source.</div>';
  $('#flags').innerHTML=flags;
  const v=q.vision||{};
  $('#problem').innerHTML=q.problem_summary||v.visible_problem?'<div>'+esc(q.problem_summary||v.visible_problem)+'</div>'+(v.fixture?'<div class="muted" style="font-size:14px;margin-top:4px">Fixture: '+esc(v.fixture)+(v.brand_guess?' · Brand: '+esc(v.brand_guess):'')+(q.label&&q.label.model_number?' · Model: <b>'+esc(q.label.model_number)+'</b>':'')+'</div>':''):'<span class="muted">Waiting for the call…</span>';
  if(q.snapshots&&q.snapshots.length){$('#snaps-card').hidden=false;$('#snaps').innerHTML=q.snapshots.map(s=>'<figure><a href="'+esc(s.url)+'" target="_blank"><img src="'+esc(s.path||s.url)+'" alt=""></a><figcaption>'+esc(s.label)+'</figcaption></figure>').join('');}
  const e=q.estimate;
  if(e){
    $('#lines').className='';
    $('#lines').innerHTML='<table><thead><tr><th>Item</th><th class="amt">Amount</th></tr></thead><tbody>'+e.lines.map(l=>{
      let r='';
      if(l.verified&&l.source_url)r='<span class="badge ok">Verified</span> <a href="'+esc(l.source_url)+'" target="_blank">source ↗</a>';
      else if(l.verified)r='<span class="badge ok">Price book</span>';
      else r='<span class="badge warn">Unverified</span> '+esc(l.note||'');
      if(l.snapshot_url)r+='<a href="'+esc(l.snapshot_url)+'" target="_blank"><img src="'+esc(l.snapshot_url)+'" alt=""></a>';
      const qty=l.kind==='labor'?l.qty+' h × '+money(l.unit):(l.qty>1?l.qty+' × '+money(l.unit):'');
      return '<tr><td><div>'+esc(l.label)+'</div>'+(qty?'<div class="muted" style="font-size:13px">'+qty+'</div>':'')+'<div class="receipt">'+r+'</div></td><td class="amt">'+money(l.amount)+'</td></tr>';
    }).join('')+(e.tax?'<tr><td>Tax</td><td class="amt">'+money(e.tax)+'</td></tr>':'')+'<tr class="total"><td>Total</td><td class="amt">'+money(e.total)+'</td></tr></tbody></table>';
    if(MODE==='contractor'&&!$('#hours').value)$('#hours').value=e.hours;
  }
  $('#trace').innerHTML=(q.events||[]).slice().reverse().map(ev=>'<li><time>'+new Date(ev.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'</time><b>'+esc(ev.type)+'</b> '+esc(ev.text)+'</li>').join('')||'<li class="muted">No events yet.</li>';
  if(MODE==='contractor'){const done=q.status==='approved'||q.status==='rejected';$('#approve').disabled=done||!e;$('#edit').disabled=done||!e;}
}
async function load(){try{const r=await fetch('/api/quote/'+ID,{cache:'no-store'});if(r.ok)render(await r.json());}catch(e){}}
load();setInterval(load,2000);
if(MODE==='contractor'){
  async function act(body){$('#ctl-msg').textContent='Working…';const r=await fetch('/api/quote/'+ID+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,...body})});const j=await r.json();if(!r.ok){$('#ctl-msg').textContent='Error: '+(j.error||r.status);return;}render(j);$('#ctl-msg').textContent=body.action==='approve'?(j.notify&&j.notify.ok?(j.notify.dry_run?'Approved. (iMessage dry run: no CHERT_SIGNING_SECRET set)':'Approved and texted to the homeowner.'):'Approved. Homeowner text not sent: '+esc(j.notify&&j.notify.error||'no phone')):'Updated.';}
  $('#edit').onclick=()=>act({action:'edit',hours:Number($('#hours').value)});
  $('#approve').onclick=()=>act({action:'approve'});
}
</script></body></html>`;
}

function indexPage() {
  const list = Object.values(quotes).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quotes</title><style>${CSS}</style></head><body><div class="wrap">
<header><h1>Recent quotes</h1><span class="muted">${list.length}</span></header><div class="card list">${list.length ? list.map(q => `<a href="/q/${q.id}"><b>#${q.id}</b> · ${esc(q.estimate?.job_label || q.problem_summary || 'in progress')} · ${q.estimate ? '$' + q.estimate.total.toFixed(2) : ''} <span class="muted">· ${esc(q.status)} · ${new Date(q.created_at).toLocaleTimeString()}</span></a>`).join('') : '<div class="empty">No quotes yet. Make a FaceTime call to the agent.</div>'}</div></div></body></html>`;
}

function notFound(msg = 'No quote at this address.') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>${CSS}</style></head><body><div class="wrap"><div class="card empty">${esc(msg)}</div></div></body></html>`;
}
