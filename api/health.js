// api/health.js — a 3-second answer to "is everything actually connected?"
//
// ============================================================================
// WHY THIS EXISTS
// ----------------------------------------------------------------------------
// Every external dependency in this app degrades GRACEFULLY on purpose: if
// Supabase, College Scorecard or BEA is unreachable, matching still returns a
// full set of results and the student never sees an error. That's the right
// behaviour for students — but it meant a two-day total outage of feedback
// storage looked identical to everything working, and was only discoverable by
// reading Vercel logs. Silent degradation without a health signal is how you
// end up shipping with a broken backend and no idea.
//
// So: open /api/health (or the app with ?health=1) and every dependency reports
// its real state. Read-only — it never writes a row, never returns row data, and
// never echoes a key. It reports only whether a credential is PRESENT (boolean)
// and whether the service ANSWERS.
// ============================================================================

const PROBE_TIMEOUT_MS = 6000;

function normalizeSupabaseUrl(url) {
  return String(url ?? '').trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

// Read-only existence probe against one PostgREST table. `limit=0` asks for the
// schema path only — no rows leave the database.
async function probeTable(base, key, table) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(`${base}/rest/v1/${table}?select=*&limit=0`, {
      signal: controller.signal,
      headers: { apikey: key, Prefer: 'count=none' },
    });
    const ms = Date.now() - started;
    if (resp.ok) return { ok: true, status: 'connected', ms };
    const body = await resp.text().catch(() => '');
    return {
      ok: false,
      status: resp.status === 404 ? 'table missing' : `rejected (HTTP ${resp.status})`,
      detail: body.slice(0, 200),
      ms,
    };
  } catch (e) {
    const ms = Date.now() - started;
    const timedOut = e && e.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 'timed out' : 'unreachable',
      detail: timedOut
        ? 'No response within 6s'
        : 'Network-level failure — the usual cause is the Supabase project being paused',
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

// The models this app actually uses. Kept in sync with match.js by hand — the
// point of this probe is to prove THESE model names are callable by THIS key,
// so pointing it at anything else would defeat the purpose.
const MODEL_FINAL = 'claude-opus-4-5';
const MODEL_CANDIDATES = 'claude-haiku-4-5-20251001';

// A deliberately tiny live request: 1 token out, one-character prompt. Costs a
// fraction of a cent and takes about a second, but it exercises the real path —
// key validity, account standing, and crucially tier access to this model.
async function probeModel(model, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
    });
    if (resp.ok) return { ok: true, detail: '' };
    const body = await resp.json().catch(() => ({}));
    const msg = (body && body.error && body.error.message) ? body.error.message : `HTTP ${resp.status}`;
    // Anthropic returns "credit balance is too low" for three different causes.
    // Say so, rather than sending someone to check a balance that's already fine.
    const overloaded = /credit balance/i.test(msg);
    return {
      ok: false,
      detail: overloaded
        ? `${msg} — NOTE: this same message is returned when the account tier cannot access "${model}", or when the key is stale. Check model access and try a freshly minted key before assuming it's billing.`
        : msg,
    };
  } catch (e) {
    return { ok: false, detail: e && e.name === 'AbortError' ? 'No response within 6s' : `Network failure: ${e && e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, status: 'ANTHROPIC_API_KEY missing', required: true };

  const started = Date.now();
  const [final, candidates] = await Promise.all([
    probeModel(MODEL_FINAL, apiKey),
    probeModel(MODEL_CANDIDATES, apiKey),
  ]);
  const ms = Date.now() - started;

  if (final.ok && candidates.ok) {
    return { ok: true, status: `both models responding (${MODEL_FINAL}, ${MODEL_CANDIDATES})`, ms, required: true };
  }
  // The final model is the one matching cannot live without; the shortlist model
  // failing only costs the two-pass path, which degrades to single-pass.
  const broken = !final.ok ? final : candidates;
  const which = !final.ok ? MODEL_FINAL : MODEL_CANDIDATES;
  return {
    ok: false,
    status: `${which} rejected`,
    detail: broken.detail,
    ms,
    required: !final.ok,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const checks = {};

  // The matching check makes a REAL call. An earlier version only reported
  // whether the key existed, which was true and useless: on 2026-08-20 this
  // screen would have shown "AI matching — key set" in green while every single
  // match was failing, because the account tier had no access to the requested
  // model. Key presence proves nothing. Only a real request proves the exact
  // model this app uses can actually be called by this exact key.
  checks.matching = await probeAnthropic();
  checks.schoolData = {
    ok: !!process.env.SCORECARD_API_KEY,
    status: process.env.SCORECARD_API_KEY ? 'key set' : 'SCORECARD_API_KEY missing — results fall back to model knowledge',
    required: false,
  };
  checks.costOfLiving = {
    ok: !!process.env.BEA_API_KEY,
    status: process.env.BEA_API_KEY ? 'key set' : 'BEA_API_KEY missing — "Low Cost of Living" card falls back to model knowledge',
    required: false,
  };

  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!rawUrl || !key) {
    const status = 'SUPABASE_URL / SUPABASE_SECRET_KEY not set';
    checks.feedbackStorage = { ok: false, status, required: false };
    checks.knowledgeBase = { ok: false, status, required: false };
  } else {
    const base = normalizeSupabaseUrl(rawUrl);
    // Both tables live in the same project, but probing each separately means a
    // missing table is distinguishable from the whole project being down.
    const [feedback, kb] = await Promise.all([
      probeTable(base, key, 'school_feedback'),
      probeTable(base, key, 'institution_facts'),
    ]);
    checks.feedbackStorage = { ...feedback, required: false };
    checks.knowledgeBase = { ...kb, required: false };
  }

  const labels = {
    matching: 'AI matching (Anthropic)',
    schoolData: 'School data (College Scorecard)',
    costOfLiving: 'Cost of living (BEA)',
    feedbackStorage: 'Feedback storage (Supabase)',
    knowledgeBase: 'NCAA + campus safety data (Supabase)',
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  const criticalOk = Object.entries(checks).every(([, c]) => !c.required || c.ok);

  return res.status(200).json({
    ok: allOk,
    // The app still serves students as long as the critical path is up; the rest
    // degrade to model knowledge rather than failing.
    servingStudents: criticalOk,
    checkedAt: new Date().toISOString(),
    labels,
    checks,
  });
}
