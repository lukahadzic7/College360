// api/feedback.js — stores each student's yes/no "was this a good fit?" response
// per recommended school. Supabase Postgres via its REST/PostgREST API — no npm
// dependency, called with plain fetch() to match match.js's zero-dependency style.
//
// ============================================================================
// 2026-08-20 — REBUILT AFTER A REAL PRODUCTION OUTAGE
// ----------------------------------------------------------------------------
// Vercel runtime logs showed EVERY call to this endpoint failing: 9/9 requests
// returned 500 in 24h, 15 errors over two days, all with `TypeError: fetch
// failed`. That error is a NETWORK-level failure (DNS/connect/TLS), not an HTTP
// error from Supabase — the request never arrived. Every student's rating was
// being dropped on the floor.
//
// Nobody noticed because the frontend calls this fire-and-forget
// (`.catch(()=>{})`), so a total backend outage looked identical to success
// from inside the app. Three changes so that can never happen again:
//
//   1. URL NORMALIZATION. Supabase's dashboard hands out a Project URL that may
//      already include "/rest/v1/". This file used to append its own "/rest/v1/"
//      to whatever was in the env var, producing a doubled path. match.js and
//      the kb-ingest script both already guard against this; this file did not.
//      Same normalizeSupabaseUrl() logic is now applied here.
//   2. RETRIES. A transient network blip killed the write outright. Now retried
//      with backoff before giving up.
//   3. NEVER RETURN 500. The client ignores the response anyway, so a 500 bought
//      us nothing but noise in the error dashboard — and buried the real signal.
//      This now always returns 200 with an explicit {stored:true|false, reason},
//      and logs a precise, greppable diagnosis (including the resolved host, so
//      a misconfigured env var is obvious at a glance — never the key itself).
//
// If storage is down, `stored:false` plus a `feedback_dropped` log is the signal
// to look for. The student's experience is unaffected either way.
// ============================================================================

const ATTEMPTS = 3;
const TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip a trailing "/rest/v1" (with or without slash) and any trailing slashes,
// so the path this file appends can't be doubled up. Mirrors match.js.
export function normalizeSupabaseUrl(url) {
  return String(url ?? '').trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

// Host only, for logging. Never logs the key, and never the full URL with query.
function hostOf(url) {
  try { return new URL(url).host; } catch { return '(unparseable URL)'; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      matchId, schoolName, schoolLocation, fitPercent, admissibility,
      response, studentProfile, categoryRank,
    } = req.body || {};

    if (!matchId || !schoolName || (response !== 'yes' && response !== 'no')) {
      return res.status(400).json({ error: 'matchId, schoolName, and response ("yes"|"no") are required' });
    }

    const rawUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!rawUrl || !secretKey) {
      console.warn(JSON.stringify({
        event: 'feedback_dropped',
        reason: 'env_not_configured',
        hasUrl: !!rawUrl, hasKey: !!secretKey,
        matchId, schoolName, response,
        ts: new Date().toISOString(),
      }));
      return res.status(200).json({ stored: false, reason: 'storage not configured' });
    }

    const base = normalizeSupabaseUrl(rawUrl);
    const endpoint = `${base}/rest/v1/school_feedback`;

    const row = {
      match_id: String(matchId),
      school_name: String(schoolName),
      school_location: schoolLocation ? String(schoolLocation) : null,
      fit_percent: Number.isFinite(Number(fitPercent)) ? Number(fitPercent) : null,
      admissibility: admissibility ? String(admissibility) : null,
      response,
      student_profile: studentProfile || null,
      category_rank: Array.isArray(categoryRank) ? categoryRank : null,
    };

    let lastReason = 'unknown';
    let lastDetail = '';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            // Supabase's sb_secret_... key goes in `apikey` ONLY. A non-JWT key
            // in Authorization: Bearer gets rejected downstream by Postgres.
            apikey: secretKey,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(row),
        });

        if (resp.ok) {
          console.log(JSON.stringify({
            event: 'feedback_stored',
            matchId, schoolName, response, attempt,
            ts: new Date().toISOString(),
          }));
          return res.status(200).json({ stored: true });
        }

        // Reached Supabase but it refused. Not worth retrying a 4xx (bad key,
        // missing table, malformed row) — only a 5xx is plausibly transient.
        const body = await resp.text().catch(() => '');
        lastReason = `http_${resp.status}`;
        lastDetail = body.slice(0, 300);
        if (resp.status < 500) break;

      } catch (e) {
        // Network-level failure: DNS, connect refused, TLS, or our own timeout.
        // This is the class of error that took feedback down completely.
        lastReason = (e && e.name === 'AbortError') ? 'timeout' : 'network';
        lastDetail = (e && e.message) ? String(e.message).slice(0, 300) : '';
      } finally {
        clearTimeout(timer);
      }

      if (attempt < ATTEMPTS) await sleep(300 * attempt);
    }

    // Exhausted. Log loudly and precisely, but still 200 — the student's screen
    // must not depend on our analytics pipeline being healthy.
    console.error(JSON.stringify({
      event: 'feedback_dropped',
      reason: lastReason,
      detail: lastDetail,
      host: hostOf(endpoint),
      hint: lastReason === 'network' || lastReason === 'timeout'
        ? 'Supabase unreachable — check the project is not paused, and that SUPABASE_URL is the Project URL'
        : 'Supabase rejected the write — check the key and that table school_feedback exists',
      attempts: ATTEMPTS,
      matchId, schoolName, response,
      ts: new Date().toISOString(),
    }));
    return res.status(200).json({ stored: false, reason: lastReason });

  } catch (error) {
    // Last-resort guard. Still 200 for the same reason as above.
    console.error(JSON.stringify({
      event: 'feedback_dropped',
      reason: 'handler_exception',
      detail: error && error.message,
      ts: new Date().toISOString(),
    }));
    return res.status(200).json({ stored: false, reason: 'handler exception' });
  }
}
