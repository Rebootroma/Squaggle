// Deterministic quote builder. The model never does arithmetic: it passes a job type and a
// part price (with its source), and this file turns the price book into line items.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function loadPricebook(path = join(here, 'pricebook.json')) {
  const book = JSON.parse(readFileSync(path, 'utf8'));
  // Contractor overrides from the environment, so a real contractor's numbers can be used.
  const c = book.contractor;
  if (process.env.CONTRACTOR_NAME) c.name = process.env.CONTRACTOR_NAME;
  if (process.env.CONTRACTOR_RATE) c.hourly_rate = Number(process.env.CONTRACTOR_RATE);
  if (process.env.CONTRACTOR_TRIP_FEE) c.trip_fee = Number(process.env.CONTRACTOR_TRIP_FEE);
  if (process.env.CONTRACTOR_MARKUP_PCT) c.parts_markup_pct = Number(process.env.CONTRACTOR_MARKUP_PCT);
  return book;
}

export function listJobTypes(book = loadPricebook()) {
  return Object.entries(book.jobs).map(([key, j]) => `${key}: ${j.label} (${j.hours}h)`);
}

const cents = n => Math.round(n * 100) / 100;

/**
 * @param {object} input
 * @param {string} input.jobType            key in pricebook.jobs
 * @param {Array<{name:string, price?:number, source_url?:string, verified?:boolean, snapshot_url?:string, note?:string}>} [input.parts]
 * @param {number} [input.hoursOverride]
 * @param {object} [input.book]
 */
export function buildQuote({ jobType, parts, hoursOverride, book = loadPricebook() }) {
  const job = book.jobs[jobType];
  if (!job) {
    const err = new Error(`Unknown job type "${jobType}". Known: ${Object.keys(book.jobs).join(', ')}`);
    err.code = 'unknown_job';
    throw err;
  }
  const c = book.contractor;
  const lines = [];
  const flags = [];

  // Parts. If none given, fall back to the price book default (unverified).
  let partList = Array.isArray(parts) && parts.length ? parts : [];
  if (!partList.length && job.default_part) {
    partList = [{ ...job.default_part, verified: false, note: 'Price book default; no live price found' }];
  }
  for (const p of partList) {
    const price = Number(p.price);
    const hasPrice = Number.isFinite(price) && price > 0;
    const verified = Boolean(p.verified && p.source_url && hasPrice);
    const unit = hasPrice ? price : (job.default_part?.price ?? 0);
    if (!verified) flags.push(`Part "${p.name}" price is unverified`);
    lines.push({
      kind: 'part',
      label: p.name,
      qty: p.qty ?? 1,
      unit: cents(unit),
      amount: cents(unit * (p.qty ?? 1)),
      verified,
      source_url: p.source_url || null,
      snapshot_url: p.snapshot_url || null,
      note: p.note || (verified ? 'Live price via Keenable search' : 'Unverified'),
    });
  }
  const partsSubtotal = cents(lines.reduce((s, l) => s + l.amount, 0));

  if (c.parts_markup_pct && partsSubtotal > 0) {
    lines.push({
      kind: 'markup',
      label: `Parts markup (${c.parts_markup_pct}%)`,
      qty: 1,
      unit: cents(partsSubtotal * c.parts_markup_pct / 100),
      amount: cents(partsSubtotal * c.parts_markup_pct / 100),
      verified: true,
      note: 'From contractor price book',
    });
  }

  const hours = Number.isFinite(hoursOverride) && hoursOverride > 0 ? hoursOverride : job.hours;
  lines.push({
    kind: 'labor',
    label: `Labor: ${job.label}`,
    qty: hours,
    unit: c.hourly_rate,
    amount: cents(hours * c.hourly_rate),
    verified: true,
    note: `${hours} h × $${c.hourly_rate}/h from price book`,
  });

  if (c.trip_fee) {
    lines.push({ kind: 'trip', label: 'Trip fee', qty: 1, unit: c.trip_fee, amount: c.trip_fee, verified: true, note: 'From contractor price book' });
  }

  const subtotal = cents(lines.reduce((s, l) => s + l.amount, 0));
  const tax = cents(subtotal * (c.tax_pct || 0) / 100);
  const total = cents(subtotal + tax);

  return {
    trade: book.trade,
    currency: book.currency,
    contractor: { name: c.name, hourly_rate: c.hourly_rate },
    job_type: jobType,
    job_label: job.label,
    hours,
    lines,
    subtotal,
    tax,
    total,
    unverified_count: lines.filter(l => !l.verified).length,
    flags,
  };
}

// CLI: node estimator.mjs faucet_cartridge_replace 26.46 "Moen 1225" https://shop.moen.com/products/1225
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , jobType = 'faucet_cartridge_replace', price, name = 'Part', url] = process.argv;
  const parts = price ? [{ name, price: Number(price), source_url: url, verified: Boolean(url) }] : [];
  console.log(JSON.stringify(buildQuote({ jobType, parts }), null, 2));
}
