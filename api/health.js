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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const checks = {};

  // Credential presence only — never the values themselves.
  checks.matching = {
    ok: !!process.env.ANTHROPIC_API_KEY,
    status: process.env.ANTHROPIC_API_KEY ? 'key set' : 'ANTHROPIC_API_KEY missing',
    required: true,
  };
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
