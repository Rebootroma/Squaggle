// iMessage via Chert's Messaging API. Dry-runs (logs only) when CHERT_SIGNING_SECRET is not set,
// so the rest of the demo keeps working.
const SEND_URL = process.env.CHERT_SEND_URL || 'https://console.trychert.com/api/v1/send';

export async function sendIMessage(phone, body) {
  const secret = process.env.CHERT_SIGNING_SECRET;
  if (!phone) return { ok: false, dry_run: true, error: 'no phone number' };
  if (!secret) {
    console.log(`[imessage dry-run] to ${phone}: ${body}`);
    return { ok: true, dry_run: true, phone };
  }
  try {
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, body }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok) return { ok: false, status: res.status, error: json };
    return { ok: true, dry_run: false, phone, message_id: json.message_id, lead_id: json.lead_id };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// CLI: node --env-file=.env.local chert-sms.mjs +14155551234 "hello"
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  sendIMessage(process.argv[2], process.argv.slice(3).join(' ') || 'Test from quote agent').then(r => console.log(r));
}
