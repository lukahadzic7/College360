// api/feedback.js — stores each student's yes/no "was this a good fit?" response
// per recommended school. This is the first piece of College360's own real
// backend storage (Supabase Postgres via its REST/PostgREST API — no npm
// dependency needed, called with plain fetch() to match match.js's existing
// zero-dependency style).
//
// Graceful by design: if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set
// yet, this responds 200 (so the frontend, which fire-and-forgets this call,
// never breaks) but logs a passive warning so Luka can see in Vercel logs that
// feedback is being dropped until the env vars are added.
//
// Setup (once): create a Supabase project, run the SQL in
// supabase-feedback-schema.sql (handed off alongside this file) in the SQL
// editor, then add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as Vercel env
// vars (Project Settings → API in Supabase for both values). Uses the SERVICE
// ROLE key deliberately — this endpoint runs server-side only and is never
// exposed to the browser, so it can bypass Row Level Security safely.

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

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      // No-op so the frontend never sees an error — but log it, since silently
      // dropping real feedback data is exactly the kind of thing Luka needs to
      // be able to notice (mirrors the passive match_success/match_error log
      // pattern already used in api/match.js).
      console.warn(JSON.stringify({
        event: 'feedback_storage_not_configured',
        matchId, schoolName, response,
        ts: new Date().toISOString(),
      }));
      return res.status(200).json({ stored: false, reason: 'storage not configured' });
    }

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

    const resp = await fetch(`${supabaseUrl}/rest/v1/school_feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(JSON.stringify({
        event: 'feedback_store_error',
        status: resp.status, body: errText.slice(0, 500),
        ts: new Date().toISOString(),
      }));
      return res.status(502).json({ error: 'Could not store feedback' });
    }

    console.log(JSON.stringify({
      event: 'feedback_stored',
      matchId, schoolName, response,
      ts: new Date().toISOString(),
    }));
    return res.status(200).json({ stored: true });

  } catch (error) {
    console.error(JSON.stringify({
      event: 'feedback_error',
      message: error && error.message,
      ts: new Date().toISOString(),
    }));
    return res.status(500).json({ error: error.message });
  }
}
