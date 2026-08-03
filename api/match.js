export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const {
      mustHave: rawMustHave, wouldLike, dontCare, preferNot, dontLike,
      studentProfile, mustHaveByCategory, wouldLikeByCategory, categoryRank,
    } = req.body;
    const p = studentProfile || {};

    // Defensive server-side cap: the frontend enforces a 12-card Must Have limit
    // (raised from an unlimited count so each Must Have carries more signal for
    // the model), but never trust the client alone — clamp here too.
    const mustHave = Array.isArray(rawMustHave) ? rawMustHave.slice(0, 12) : [];
    if (Array.isArray(rawMustHave) && rawMustHave.length > 12) {
      console.warn(JSON.stringify({ event: 'must_have_over_cap', received: rawMustHave.length, ts: new Date().toISOString() }));
    }

    // Detect whether the student signaled a need for financial aid anywhere in
    // their card sort or profile. Drives net-price (vs sticker-price) evaluation.
    const aidSignals = ['financial aid', 'need significant financial aid', 'needs significant financial aid', 'need-based aid', 'meets full need'];
    const allCards = [...(mustHave || []), ...(wouldLike || [])].map(c => String(c).toLowerCase());
    const budgetStr = String(p.budget || '').toLowerCase();
    const needsAid =
      allCards.some(c => aidSignals.some(s => c.includes(s))) ||
      aidSignals.some(s => budgetStr.includes(s)) ||
      budgetStr.includes('under $15') || budgetStr.includes('significant');

    // Summarize how the student's MUST HAVE + WOULD LIKE cards distribute across
    // the 6 preference categories (Fields of Study now lives only in the intake
    // major question, not as sortable cards) so the model can weight by DIMENSION,
    // not just
    // by individual card. MUST HAVE counts double. Empty if frontend didn't send it.
    const dimCounts = {};
    for (const [cat, names] of Object.entries(mustHaveByCategory || {})) {
      dimCounts[cat] = (dimCounts[cat] || 0) + (Array.isArray(names) ? names.length : 0) * 2;
    }
    for (const [cat, names] of Object.entries(wouldLikeByCategory || {})) {
      dimCounts[cat] = (dimCounts[cat] || 0) + (Array.isArray(names) ? names.length : 0);
    }
    const dimRows = Object.entries(dimCounts).sort((a, b) => b[1] - a[1]);
    const dimensionSection = dimRows.length
      ? "\nPRIORITY DIMENSIONS (how this student's MUST HAVE + WOULD LIKE cards spread across the 6 categories, ranked by weight; MUST HAVE counts double). Use this to see what matters MOST to this student and to balance the final list across their emphasized dimensions, not just isolated cards. If one or two dimensions dominate, weight schools that genuinely excel on those:\n"
        + dimRows.map(([cat, w]) => `- ${cat} (weight ${w})`).join('\n') + '\n'
      : '';

    // Student's SELF-DECLARED category priority, collected before the card sort
    // even begins (a ranking screen shown right after intake). This is a
    // SECONDARY, directional signal only — it must never override what the
    // student's actual MUST HAVE / WOULD LIKE card choices say. If the two
    // signals ever conflict, the card-based dimensionSection above wins.
    const rankSection = (Array.isArray(categoryRank) && categoryRank.length)
      ? "\nSTUDENT'S DECLARED CATEGORY PRIORITY (self-ranked before seeing any cards, 1 = most important): "
        + categoryRank.map((c, i) => `${i + 1}. ${c}`).join(', ')
        + ". Use this only as directional context for what broadly matters most to this student. It must NEVER override or contradict the PRIORITY DIMENSIONS above, which are derived from their actual card choices during the sort — those are the authoritative signal. If this declared ranking and the card-based dimensions ever seem to disagree, trust the card-based dimensions.\n"
      : '';

    // Live cost-of-living reference (BEA state Regional Price Parities) — only
    // fetched when the student actually cares about cost of living, to avoid
    // latency on every sort. No-op if BEA_API_KEY is unset or the API is down.
    const wantsLowCost = [...(mustHave || []), ...(wouldLike || [])].some(c => /low cost of living/i.test(String(c)));
    const rppSection = wantsLowCost ? buildRppSection(await fetchStateRPP(process.env.BEA_API_KEY)) : '';

    // GPA is now a free-typed number plus a self-reported scale (weighted /
    // unweighted / unspecified) instead of a fixed dropdown range. Build a
    // plain-language description so the prompt below can interpret it, since
    // weighted and unweighted numbers mean very different things.
    const gpaScale = String(p.gpaScale || '').toLowerCase();
    const gpaDisplay = p.gpa
      ? `${p.gpa}${gpaScale === 'weighted' ? ' (weighted scale)' : gpaScale === 'unweighted' ? ' (unweighted 4.0 scale)' : ' (scale not specified — treat as unweighted)'}`
      : 'Not specified';

    const profileContext = `
STUDENT PROFILE (use this to calibrate every recommendation):
- Home state: ${p.location || 'Not specified'}
- GPA: ${gpaDisplay}
- Standardized testing: ${p.testType || 'Not specified'}${p.testScore && p.testScore !== 'N/A' ? ` (Score: ${p.testScore})` : ''}
- Annual budget: ${p.budget || 'Not specified'}
- Intended major: ${p.major || 'Not specified'}
- Grade level: ${p.grade || 'Not specified'}
- Financial-aid need detected: ${needsAid ? 'YES - evaluate affordability on NET price, not sticker price' : 'No explicit aid signal - use stated budget'}`;

    const prompt = `You are an expert college counselor with encyclopedic, fact-based knowledge of US colleges and universities. A student has completed the Next4 preference card sort. Your job is to recommend their top 10 best-fit colleges with extreme precision and accuracy.

${profileContext}

STUDENT CARD SORT PREFERENCES:
MUST HAVE (deal-maker - school must satisfy these or it cannot be recommended): ${(mustHave || []).join(', ') || 'none'}
WOULD LIKE THIS (high priority - strongly weight these in scoring): ${(wouldLike || []).join(', ') || 'none'}
DOESN'T MATTER (neutral): ${(dontCare || []).join(', ') || 'none'}
WOULD RATHER NOT (negative weight - penalize schools with these traits): ${(preferNot || []).join(', ') || 'none'}
NOT FOR ME (deal-breaker - automatically disqualify any school strongly associated with these): ${(dontLike || []).join(', ') || 'none'}
${dimensionSection}${rankSection}${rppSection}

==================================================================
DATA SOURCE ANCHORING - read first, applies to every number you output
==================================================================
Your training data drifts and schools change selectivity, price, and programs every year. Do NOT pull statistics from memory alone. Anchor every numeric claim to what these authoritative public sources report, and reason as if you are reading the current figures from them:
- IPEDS (enrollment, undergrad size, completion/graduation rates, admissions data)
- College Scorecard (admit rate, SAT/ACT ranges, NET PRICE by income band, median earnings, completion)
- Each school's Common Data Set (CDS): admit rate (section C1-C2), GPA & test percentiles (C9-C12), financial aid (H), enrollment by major (J)
- NCES College Navigator (size, setting, programs, costs)
- Each school's official admissions page, financial-aid office page, and Net Price Calculator (NPC)
- Program accreditors for major-strength claims: ABET (engineering/CS), AACSB (business), CCNE or ACEN (nursing), LCME (med-school placement context), NASAD/NASM (art/music)
- NSF HERD survey (research expenditures) for "strong research" claims
- NACE First-Destination data and each school's career-outcomes report for placement/job-rate claims

CONFIDENCE RULE: Every numeric tag (admit rate, net price, test percentile, enrollment, placement rate, earnings) MUST be anchored to a source above. If you are not confident a figure is current and correct, do NOT state a precise number - describe it as approximate ("~"), round conservatively, choose the MORE conservative admissibility tier, and flag the uncertainty in the caveat sentence. Never fabricate precise statistics.

==================================================================
GPA INTERPRETATION - read the scale before applying tiers below
==================================================================
The student's GPA was collected as a free-typed number plus a self-reported scale (weighted or unweighted), not a fixed range. Interpret it carefully before applying the SEARCH AMBITION tiers below:
- Unweighted (standard 4.0 scale): 4.0 = essentially all A's. Apply the tiers below directly to this number.
- Weighted (commonly runs up to ~5.0): schools typically add roughly +0.5 to +1.0 per Honors/AP/IB class, so a weighted number overstates true unweighted rigor. Mentally discount a weighted number toward its likely unweighted-equivalent before applying the tiers below - a 4.3 weighted GPA is roughly comparable to a high-3-point unweighted student's rigor, NOT a perfect unweighted student. Use reasonable judgment based on typical weighting conventions rather than a rigid formula.
- Scale not specified: treat the number as unweighted (the more conservative assumption).

==================================================================
TWO INDEPENDENT SYSTEMS - do not let them contradict each other
==================================================================
SYSTEM A - SEARCH AMBITION (how selective the schools you SEARCH should be).
This tells you how high to aim. It does NOT label individual schools. Apply these tiers to the INTERPRETED (scale-adjusted) GPA from above:
- Interpreted GPA 4.1+ with SAT 1450+ or ACT 33+: search includes highly selective schools (admit rate under 20%)
- Interpreted GPA 3.6-4.0 with SAT 1300-1450 or ACT 28-32: selective and mid-selective (admit 20-50%)
- Interpreted GPA 3.1-3.5 with SAT 1100-1290 or ACT 22-27: mostly accessible schools (admit 50-80%), a few stretch options
- Interpreted GPA 2.6-3.0: accessible / broad-access schools (admit 70%+)
- Interpreted GPA 2.0-2.5: accessible schools, community-college transfer pathways
- Interpreted GPA 1.6-1.9: open-admission schools, community colleges, schools with strong academic support and transfer pathways
- Interpreted GPA 1.5 and below: community colleges, trade schools, certification programs, schools with extensive academic support
- Test-optional or no scores: rely on interpreted GPA alone, lean conservative on selectivity

SYSTEM B - PER-SCHOOL ADMISSIBILITY CLASSIFICATION (label each result honestly).
SEPARATELY, for EACH school you recommend, compare THIS student's interpreted GPA and test scores to THAT school's admitted-student profile (anchor to the school's Common Data Set / College Scorecard / IPEDS) and classify it independently:
- "Likely": student's GPA/test are at or above the school's 75th-percentile admitted profile, and admit rate is not punishing.
- "Target": student's stats fall within the school's middle-50% admitted profile.
- "Reach": student's stats are below the 25th percentile, OR the school's admit rate is under 20% (sub-20% schools are a Reach for everyone, regardless of stats).

These two systems are INDEPENDENT. System A decides how high to aim; System B honestly labels each result. A top-tier student will still have Reach schools (e.g., sub-20% admit schools) and must also have at least one Likely. Never let the GPA tier override the honest per-school label.
HARD REQUIREMENT: the final list of 8 MUST contain at least 1 "Likely" and at least 1 "Reach", and must NOT be entirely "Reach".

==================================================================
AFFORDABILITY - NET price when aid is needed, sticker otherwise
==================================================================
${needsAid
  ? `This student needs financial aid. Evaluate affordability on ESTIMATED NET PRICE after need-based aid (anchor: College Scorecard net-price-by-income + the school's Net Price Calculator), NOT published sticker tuition.
- ACTIVELY INCLUDE high-sticker schools that meet ~100% of demonstrated need (e.g., Ivies, Stanford, MIT, Amherst, Williams, Pomona, Bowdoin) and well-endowed liberal-arts colleges - for an aided student their net price is often far below an out-of-state public, and excluding them on sticker price alone is a mistake.
- Do NOT exclude a school for a high sticker price if its likely net price fits the student's means. Note the sticker-vs-net distinction in the caveat.`
  : `No explicit aid need was signaled - filter on the student's stated budget against typical cost. IMPORTANT: for public universities, sticker tuition depends heavily on residency - always distinguish in-state vs out-of-state sticker price for THIS student's home state, never assume in-state pricing for an out-of-state student:
- Under $15,000/year: in-state publics, community colleges, schools with major merit scholarships
- $15,000-$30,000/year: in-state publics, out-of-state publics with good aid, privates that meet full need
- $30,000-$50,000/year: most public universities, privates with strong need-based aid
- $50,000-$70,000/year: full range of private universities and elite publics
- $70,000+/year: any school, no cost filter
If you observe that a high-sticker school would likely be far cheaper after aid for this student, still surface it and explain the net-price reality in the caveat.`}

MAJOR PRIORITIZATION:
- If a specific major is selected: only recommend schools genuinely strong in that field (anchor to accreditor + outcomes data).
- Engineering: only ABET-accredited programs. Business: only AACSB-accredited or strong undergrad business. Nursing: only CCNE/ACEN-accredited. Pre-Med: strong advising + documented med-school placement. Veterinary/Pre-Vet: strong animal science + pre-vet advising.
- Undecided: prioritize schools with strong general academics and easy major exploration.

GRADE LEVEL CONTEXT:
- Freshman/Sophomore: early exploration - wider variety to broaden horizons
- Junior: active list building - realistic future application list
- Senior: final list building - only schools they could genuinely apply to and afford
- Other: balance broadly

ACCURACY RULES - follow strictly:

LOCATION: Only recommend schools physically located in preferred regions if location cards were sorted.
- Rocky Mountains = CO, ID, MT, UT, WY
- West Coast = CA, OR, WA, NV, HI, AK
- Southeast = AL, AR, FL, GA, KY, LA, MS, NC, SC, TN, VA, WV
- Mid-Atlantic = DE, MD, NJ, NY, PA, DC
- New England = CT, ME, MA, NH, RI, VT
- Great Lakes = MI, IL, IN, OH, WI
- Plains = IA, KS, MN, MO, NE, ND, SD
- Southwest = AZ, NM, OK, TX
If a region is marked Not For Me, never recommend schools from that region.

SIZE:
- Small College = under 3,000 undergrads
- Medium Sized College = 3,000 to 15,000 undergrads
- Large College = over 15,000 undergrads

INSTITUTION TYPE:
- Public / State University: state-funded institution. Sticker tuition differs sharply by residency - always use THIS student's home state to determine in-state vs out-of-state pricing.
- Private University: independently funded, not state-run. Sticker tuition does not vary by residency, though need-based/merit aid can still make net price far lower than sticker.

CULTURE & IDENTITY (Campus Culture):
- HBCU: only officially designated Historically Black Colleges and Universities
- Hispanic Serving Institution: only schools with official HSI federal designation (25%+ Hispanic enrollment)
- Native American / Tribal College: only federally recognized Tribal Colleges (TCUs) or Native American-serving institutions
- Women Only: only actual women's colleges
- Religious Campus: only schools with active religious identity
- LGBTQ+ Friendly: only schools with documented inclusive policies
- Conservative Campus: only schools widely known for conservative student culture
- Active International Student Community: only schools with 10%+ international enrollment
- Tech / Startup Culture: e.g. Stanford, MIT, CMU, Georgia Tech, Northeastern
- Strong Arts & Music Scene: schools with strong undergraduate arts presence

OUTCOMES (Resources & Support):
- High Job Placement Rate: only schools with documented 85%+ placement within 6 months (anchor to NACE / career-outcomes report)
- Direct Admit to Major: schools where students are admitted directly into competitive majors
- On-Campus Recruiting / Career Fairs: schools where major employers (Big 4, FAANG, finance) actively recruit
- Community College Transfer Pathway: schools with strong articulation agreements
- Internships Built Into Your Major: schools that require internships built into the major/curriculum for graduation (Northeastern, Drexel, Cincinnati, etc.)

ACADEMIC FLEXIBILITY (Learning Environment):
- Double Major Friendly: schools where double majoring is logistically supported
- Senior Thesis or Capstone Required: schools requiring substantial final projects

SPECIALIZED CARD DATA RULES (newer cards - anchor each to a real source; if unverifiable, hedge in the caveat and do not credit the school):
- Mental Health & Counseling Services: prioritize documented counseling capacity (low student-to-counselor ratio, short wait times, on-staff clinicians); do not credit a school merely for having a counseling center.
- Strong Internship Pipeline: prioritize documented internship participation + employer partnerships (NACE first-destination internship rates, co-op offices, named employer pipelines); distinct from internships built into the major.
- State-of-the-Art Labs & Facilities: prioritize documented recent capital investment + high research/instructional expenditures in the STUDENT'S field (NSF HERD; recent construction); scope to their major, not generic "nice buildings".
- Low Cost of Living Area: judge by the cost of living of the school's CITY/METRO (not its tuition), anchored to BEA Regional Price Parities (RPP) and HUD Fair Market Rents. "Low" = metro RPP below the national average (100) and below-median area rents. Do not credit a school in an expensive metro just because its tuition or net price is low.

WEATHER: If Snow is Not For Me, never recommend schools in MN, WI, VT, ME, NH, ND, SD, MI, upstate NY. If Warm Weather is Must Have, only schools in FL, TX, AZ, CA, HI.

==================================================================
HANDLING MUST HAVE / WOULD LIKE CARDS
==================================================================
QUALITY-WEIGHTING RULE: When a card is "Must Have" or "Would Like This," do not merely confirm the school HAS that feature - weight toward schools genuinely EXCEPTIONAL or nationally recognized for it (e.g. "Community Service" -> Tulane, Berea; "Research Opportunities" -> schools with strong, documented undergraduate research funding/output). The strength of the preference should map to the strength/reputation of that feature at the recommended school. Because Must Have selections are now capped at 12 cards, treat every Must Have as a genuinely high-signal, deliberate choice.

CATCH-ALL FALLBACK (applies to EVERY MUST HAVE without an explicit rule above): treat the card as a HARD requirement for documented institutional strength in that area. Never silently ignore a MUST HAVE. Every MUST HAVE card must be reflected in each recommended school, or that school must be excluded.

MUST HAVE ACCURACY CONFIRMATION: Before honoring any MUST HAVE on the basis of an institutional strength, CONFIRM against the anchored sources that the school verifiably and currently has that strength. If you cannot verify it, do NOT count the MUST HAVE as satisfied and do NOT recommend the school on that basis. Never claim a strength you cannot anchor to a real source.

==================================================================
FIT SCORING - use the full honest range, no artificial ceiling
==================================================================
fitPercent is an honest integer 52-99 reflecting how well the school matches the student's profile AND card priorities:
- 90-99: realistic admissibility fit AND nearly all MUST HAVE + most WOULD LIKE cards satisfied
- 75-89: matches profile and most MUST HAVEs with minor gaps
- 60-74: solid profile fit but only some preferences met
- 52-59: included for range/diversity, with notable gaps
Use the honest number. Do NOT artificially cap scores - if a school genuinely matches almost everything and is a realistic fit, a 95+ is correct. Reserve 90+ for schools that truly satisfy nearly all priorities.

EXPLANATION: The "why" field must cite specific, verifiable, source-anchored facts tied to the student's profile AND preferences (GPA/admissibility fit, net-or-sticker cost fit, major strength, specific cultural/outcome cards). Never use generic phrases like "great academics."

SCHOOL DIVERSITY: Include a mix of -
- At least 2 nationally recognized universities
- At least 2 strong regional schools the student may not have considered
- At least 1 smaller or lesser-known genuine hidden-gem fit
- Schools across different price points within the affordability range

==================================================================
OUTPUT FORMAT
==================================================================
Return ONLY valid JSON - no markdown, no backticks, no preamble, no trailing commas.
Return a JSON array of exactly 10 school objects, ordered by fitPercent descending. Each object:
- "name": full official school name
- "location": "City, ST" (e.g. "Ann Arbor, MI")
- "fitPercent": honest integer 52-99
- "admissibility": exactly one of "Likely" | "Target" | "Reach"
- "tags": an OBJECT with exactly these four NAMED string fields (named so they can never render out of order):
    - "cost": affordability tier - for public schools, distinguish in-state vs out-of-state sticker for THIS student, and net price if aid-relevant (e.g. "In-state ~$13K/yr tuition (net ~$9K after aid)" or "Out-of-state ~$40K/yr tuition")
    - "size": size category + approx undergrad enrollment (e.g. "Medium, ~9,400 ugrad")
    - "program": key program strength tied to the student's major/priorities (e.g. "Top-20 ABET Engineering")
    - "fit": admissibility label + admit-rate context (e.g. "Target, ~38% admit")
- "why": exactly 2 sentences. Sentence 1: 2-3 specific, source-anchored facts connecting the school to this student's profile and cards. Sentence 2: one honest caveat (note data-confidence if any figure is approximate). Do NOT put precise admit rates, net prices, test scores, or enrollment counts in the "why" — those exact figures appear in the tags; refer to them qualitatively here (e.g., "highly selective", "affordable after aid", "large public").

FINAL SELF-CHECK before returning - verify ALL of these and fix anything that fails:
1. Exactly 10 schools.
2. Valid JSON: no markdown, no backticks, no trailing commas.
3. Every object has name, location, fitPercent (integer 52-99), admissibility, tags{cost,size,program,fit}, and a 2-sentence why.
4. At least 1 school is "Likely" and at least 1 is "Reach"; not all are "Reach".
5. No more than 2 schools from the same state.
6. Every MUST HAVE card is reflected in the recommended schools (schools that fail a MUST HAVE were excluded).
7. Every numeric figure is source-anchored or explicitly hedged as approximate - no fabricated precise stats.
8. For every public-school cost tag, in-state vs out-of-state is correctly distinguished for THIS student's home state.`;

    // ── SCHOOL SELECTION ──────────────────────────────────────────────────
    // Two-pass when Scorecard is available (data-driven shortlist): a fast model
    // proposes candidates -> we attach REAL Scorecard data -> the strong model
    // picks the final list FROM those verified numbers. Falls back to a single
    // pass (the model's own picks) if Scorecard is off or pass 1 fails, so the
    // endpoint never breaks.
    let schools = null;
    if (process.env.SCORECARD_API_KEY) {
      try {
        schools = await runTwoPass(apiKey, p, needsAid, prompt, {
          mustHave, wouldLike, preferNot, dontLike, dimensionSection,
        });
      } catch (e) {
        console.warn('Two-pass failed; falling back to single pass:', e && e.message);
        schools = null;
      }
    }
    if (!schools) {
      schools = await callClaudeForJson(apiKey, 'claude-opus-4-5', prompt, 8000);
    }

    schools = sanitizeSchools(schools);
    // Final verification layer: replace any remembered figures with REAL
    // Scorecard data and recompute admissibility. No-op if no key / API down.
    schools = await enrichWithScorecard(schools, p, needsAid);

    // Passive success log — lets Luka grep Vercel logs for match_success vs
    // match_error counts to see clean-run-to-error ratio over time.
    console.log(JSON.stringify({
      event: 'match_success',
      schoolCount: schools.length,
      verifiedCount: schools.filter(s => s.verified).length,
      ts: new Date().toISOString(),
    }));

    return res.status(200).json({ schools });

  } catch (error) {
    console.error(JSON.stringify({
      event: 'match_error',
      message: error && error.message,
      ts: new Date().toISOString(),
    }));
    return res.status(500).json({ error: error.message });
  }
}

// Server-side validation so a malformed model response can never crash the
// frontend. Coerces types, clamps fitPercent, normalizes tags to the
// self-labeled string array the frontend renders, and logs (without
// rejecting) the soft "at least 1 Likely + 1 Reach" guarantee.
function sanitizeSchools(schools) {
  if (!Array.isArray(schools)) {
    throw new Error('Model did not return a JSON array of schools');
  }

  const cleaned = schools.slice(0, 10).map((s) => {
    const obj = (s && typeof s === 'object') ? s : {};

    let fit = parseInt(obj.fitPercent, 10);
    if (Number.isNaN(fit)) fit = 60;
    fit = Math.max(52, Math.min(99, fit));

    const admissibility = ['Likely', 'Target', 'Reach'].includes(obj.admissibility)
      ? obj.admissibility
      : 'Target';

    // Accept the named object (current) or a legacy 4-string array (cached).
    let tags = obj.tags;
    if (Array.isArray(tags)) {
      tags = {
        cost: tags[0] || '',
        size: tags[1] || '',
        program: tags[2] || '',
        fit: tags[3] || `${admissibility}`,
      };
    } else if (!tags || typeof tags !== 'object') {
      tags = { cost: '', size: '', program: '', fit: admissibility };
    }

    // Flatten to the self-labeled string array the existing frontend renders
    // (s.tags.map(...)). Named generation prevents misordering; each emitted
    // string is self-labeled, so displayed order can never be misread.
    const tagArray = [
      String(tags.cost || ''),
      String(tags.size || ''),
      String(tags.program || ''),
      String(tags.fit || admissibility),
    ].filter(Boolean);

    return {
      name: String(obj.name || 'Unknown School'),
      location: String(obj.location || ''),
      fitPercent: fit,
      admissibility,
      tags: tagArray,
      why: String(obj.why || ''),
    };
  });

  cleaned.sort((a, b) => b.fitPercent - a.fitPercent);

  const labels = cleaned.map((s) => s.admissibility);
  if (!labels.includes('Likely') || !labels.includes('Reach')) {
    console.warn('Self-check note: list is missing a Likely or a Reach classification.', labels);
  }

  return cleaned;
}

// ============================================================================
// COLLEGE SCORECARD VERIFICATION  (the "Option B" accuracy layer)
// ----------------------------------------------------------------------------
// The model picks the 8 schools, but its numbers come from training memory and
// can be stale. This layer fetches REAL, current data from the U.S. Department
// of Education's College Scorecard API for each picked school, then:
//   1. overwrites the displayed cost / size / admit-rate tags with real figures
//   2. recomputes Reach / Target / Likely from the school's actual SAT/ACT
//      percentiles vs. THIS student's score (sub-20% admit = Reach for everyone)
//
// Requires env var SCORECARD_API_KEY (free at https://api.data.gov/signup).
// If the key is missing or any lookup fails, the school keeps the model's
// values, so results always render. Field reference:
//   https://collegescorecard.ed.gov/data/documentation/
//
// NOTE FOR THE NATIVE APP: this is a clean, isolated function. A native backend
// (no serverless timeout) could extend it to a two-pass design — feed these
// verified numbers back to the model to drive SELECTION, not just display.
//
// RESIDENCY FIX (2026-07): Scorecard's avg_net_price fields are blended across
// a school's ENTIRE population (mostly in-state at big publics), which badly
// understates cost for an out-of-state full-pay student. We now also pull
// latest.cost.tuition.in_state / out_of_state (published sticker tuition by
// residency) plus the school's own id (== IPEDS UnitID) and state, and compare
// against the student's home state to show the correct sticker figure.
// ============================================================================

const SCORECARD_FIELDS = [
  'id',
  'school.name', 'school.city', 'school.state',
  'latest.student.size',
  'latest.admissions.admission_rate.overall',
  'latest.admissions.sat_scores.25th_percentile.overall',
  'latest.admissions.sat_scores.75th_percentile.overall',
  'latest.admissions.act_scores.25th_percentile.cumulative',
  'latest.admissions.act_scores.75th_percentile.cumulative',
  'latest.cost.tuition.in_state',
  'latest.cost.tuition.out_of_state',
  'latest.cost.avg_net_price.public',
  'latest.cost.avg_net_price.private',
  'latest.cost.net_price.public.by_income_level.0-30000',
  'latest.cost.net_price.public.by_income_level.30001-48000',
  'latest.cost.net_price.public.by_income_level.48001-75000',
  'latest.cost.net_price.public.by_income_level.75001-110000',
  'latest.cost.net_price.public.by_income_level.110001-plus',
  'latest.cost.net_price.private.by_income_level.0-30000',
  'latest.cost.net_price.private.by_income_level.30001-48000',
  'latest.cost.net_price.private.by_income_level.48001-75000',
  'latest.cost.net_price.private.by_income_level.75001-110000',
  'latest.cost.net_price.private.by_income_level.110001-plus',
  'latest.completion.completion_rate_4yr_150nt',
  'latest.student.retention_rate.four_year.full_time',
  'latest.earnings.10_yrs_after_entry.median',
].join(',');

async function enrichWithScorecard(schools, profile, needsAid) {
  const apiKey = process.env.SCORECARD_API_KEY;
  if (!apiKey) return schools; // graceful fallback: no key -> model output as-is

  const student = parseStudentTest(profile);
  const studentPostal = US_POSTAL_BY_NAME[String((profile && profile.location) || '').trim()] || '';

  // Look up every school in parallel; one slow/failed lookup can't block others.
  const results = await Promise.allSettled(
    schools.map((s) => fetchScorecard(s, apiKey))
  );

  return schools.map((s, i) => {
    const data = results[i].status === 'fulfilled' ? results[i].value : null;
    if (!data) return s; // not found / error -> keep the model's values untouched

    const size = data.size;
    const sizeCat = size == null ? null
      : size < 3000 ? 'Small' : size <= 15000 ? 'Medium' : 'Large';
    const admitPct = data.admitRate != null ? Math.round(data.admitRate * 100) : null;
    const net = pickNetPrice(data, needsAid, profile && profile.income);
    const sticker = pickStickerTuition(data, studentPostal);
    const admissibility = classifyAdmissibility(student, data) || s.admissibility;

    // Rebuild the self-labeled tag array with verified numbers. tags[2] (program
    // strength) stays from the model — Scorecard has no program-quality metric.
    // Cost tag now leads with the residency-correct STICKER price (the actual
    // published tuition this specific student would be charged), with the
    // aid-adjusted net price shown alongside it for context.
    const costTag = sticker != null
      ? `${sticker.label} ~$${fmtK(sticker.value)}/yr${net != null ? ` (net ~$${fmtK(net.value)}/yr${net.note})` : ''}`
      : (net != null ? `${needsAid ? 'Est. net' : 'Net'} ~$${fmtK(net.value)}/yr${net.note}` : (s.tags[0] || ''));

    const tags = [
      costTag,
      sizeCat ? `${sizeCat} · ${size.toLocaleString()} ugrad` : (s.tags[1] || ''),
      s.tags[2] || '',
      admitPct != null ? `${admissibility} · ${admitPct}% admit` : `${admissibility}`,
    ].filter(Boolean);

    return { ...s, admissibility, tags, verified: true };
  });
}

async function fetchScorecard(school, apiKey) {
  const name = String(school.name || '').trim();
  if (!name) return null;
  const state = (String(school.location || '').split(',')[1] || '').trim();

  const url = 'https://api.data.gov/ed/collegescorecard/v1/schools'
    + `?api_key=${apiKey}`
    + `&school.name=${encodeURIComponent(name)}`
    + (state ? `&school.state=${encodeURIComponent(state)}` : '')
    + `&fields=${SCORECARD_FIELDS}&per_page=10`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let json;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    json = await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const rows = (json && json.results) || [];
  if (!rows.length) return null;
  // Prefer an exact (case-insensitive) name match; otherwise take the first hit.
  const lower = name.toLowerCase();
  const row = rows.find((x) => String(x['school.name'] || '').toLowerCase() === lower) || rows[0];

  return {
    unitid: numOrNull(row['id']),
    state: String(row['school.state'] || '').trim().toUpperCase(),
    size: numOrNull(row['latest.student.size']),
    admitRate: numOrNull(row['latest.admissions.admission_rate.overall']),
    sat25: numOrNull(row['latest.admissions.sat_scores.25th_percentile.overall']),
    sat75: numOrNull(row['latest.admissions.sat_scores.75th_percentile.overall']),
    act25: numOrNull(row['latest.admissions.act_scores.25th_percentile.cumulative']),
    act75: numOrNull(row['latest.admissions.act_scores.75th_percentile.cumulative']),
    tuitionInState: numOrNull(row['latest.cost.tuition.in_state']),
    tuitionOutState: numOrNull(row['latest.cost.tuition.out_of_state']),
    netAvgPublic: numOrNull(row['latest.cost.avg_net_price.public']),
    netAvgPrivate: numOrNull(row['latest.cost.avg_net_price.private']),
    incPublic: {
      '0-30000': numOrNull(row['latest.cost.net_price.public.by_income_level.0-30000']),
      '30001-48000': numOrNull(row['latest.cost.net_price.public.by_income_level.30001-48000']),
      '48001-75000': numOrNull(row['latest.cost.net_price.public.by_income_level.48001-75000']),
      '75001-110000': numOrNull(row['latest.cost.net_price.public.by_income_level.75001-110000']),
      '110001-plus': numOrNull(row['latest.cost.net_price.public.by_income_level.110001-plus']),
    },
    incPrivate: {
      '0-30000': numOrNull(row['latest.cost.net_price.private.by_income_level.0-30000']),
      '30001-48000': numOrNull(row['latest.cost.net_price.private.by_income_level.30001-48000']),
      '48001-75000': numOrNull(row['latest.cost.net_price.private.by_income_level.48001-75000']),
      '75001-110000': numOrNull(row['latest.cost.net_price.private.by_income_level.75001-110000']),
      '110001-plus': numOrNull(row['latest.cost.net_price.private.by_income_level.110001-plus']),
    },
    gradRate: numOrNull(row['latest.completion.completion_rate_4yr_150nt']),
    retention: numOrNull(row['latest.student.retention_rate.four_year.full_time']),
    earnings: numOrNull(row['latest.earnings.10_yrs_after_entry.median']),
  };
}

// Parse the student's standardized test into { kind: 'SAT'|'ACT', score } or null.
function parseStudentTest(profile) {
  const type = String((profile && profile.testType) || '').toUpperCase();
  const score = parseInt(String((profile && profile.testScore) || '').replace(/[^0-9]/g, ''), 10);
  if (Number.isNaN(score)) return null;
  if (type.includes('SAT')) return { kind: 'SAT', score };
  if (type.includes('ACT')) return { kind: 'ACT', score };
  if (score >= 400) return { kind: 'SAT', score }; // infer from magnitude
  if (score >= 1 && score <= 36) return { kind: 'ACT', score };
  return null;
}

// Reach / Target / Likely from REAL school data + this student's test score.
function classifyAdmissibility(student, d) {
  if (d.admitRate != null && d.admitRate < 0.20) return 'Reach'; // sub-20% = Reach for all
  if (!student) return null;                                     // no score -> keep model's label
  const p25 = student.kind === 'SAT' ? d.sat25 : d.act25;
  const p75 = student.kind === 'SAT' ? d.sat75 : d.act75;
  if (p25 == null || p75 == null) return null;                   // no test data -> keep model's
  if (student.score >= p75) return 'Likely';
  if (student.score >= p25) return 'Target';
  return 'Reach';
}

// Map the intake income bands (20k bands) to Scorecard's net-price income brackets.
const INCOME_BRACKET = {
  'under-20k': '0-30000', '20k-40k': '30001-48000', '40k-60k': '48001-75000',
  '60k-80k': '48001-75000', '80k-100k': '75001-110000', '100k-120k': '75001-110000',
  '120k-plus': '110001-plus',
};

// Choose the most relevant net price + a short clarifying note. If the student gave
// an income band, use that exact Scorecard bracket; else fall back to the lowest
// bracket when aid is needed; else the school's average net price.
function pickNetPrice(d, needsAid, income) {
  const bk = INCOME_BRACKET[income];
  if (bk && d.incPublic && d.incPrivate) {
    const v = d.incPublic[bk] != null ? d.incPublic[bk] : d.incPrivate[bk];
    if (v != null) return { value: v, note: ' (est. for your income band)' };
  }
  if (needsAid) {
    const low = (d.incPublic && d.incPublic['0-30000'] != null) ? d.incPublic['0-30000']
              : (d.incPrivate && d.incPrivate['0-30000'] != null) ? d.incPrivate['0-30000'] : null;
    if (low != null) return { value: low, note: ' (lower-income est.)' };
  }
  const avg = d.netAvgPublic != null ? d.netAvgPublic : d.netAvgPrivate;
  if (avg != null) return { value: avg, note: ' (avg)' };
  return null;
}

// Residency-correct PUBLISHED (sticker) tuition — the actual number this
// specific student would be charged, distinct from the blended net-price
// average above. Falls back to whichever sticker figure exists if the
// residency-specific one is missing (e.g. private schools have no in/out
// split at all, which is expected and fine).
function pickStickerTuition(d, studentPostal) {
  const inState = !!(studentPostal && d.state && studentPostal === d.state);
  if (inState && d.tuitionInState != null) return { value: d.tuitionInState, label: 'In-state' };
  if (!inState && d.tuitionOutState != null) return { value: d.tuitionOutState, label: 'Out-of-state' };
  if (d.tuitionInState != null) return { value: d.tuitionInState, label: 'Sticker' };
  if (d.tuitionOutState != null) return { value: d.tuitionOutState, label: 'Sticker' };
  return null;
}

function numOrNull(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }
function fmtK(n) { return Math.round(n / 1000) + 'K'; }

// ============================================================================
// TWO-PASS SELECTION (data-driven shortlist)
// Pass 1 (fast model) proposes a candidate pool of real schools -> we attach
// CURRENT College Scorecard data to each -> Pass 2 (strong model) makes the
// final pick FROM those verified numbers. Any failure throws so the caller
// falls back to the proven single-pass flow.
// ============================================================================

// Fetch + robustly parse a JSON array from one Claude call.
async function callClaudeForJson(apiKey, model, prompt, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error('Anthropic ' + response.status + ': ' + JSON.stringify(err));
  }
  const data = await response.json();
  let text = (data.content || []).map(b => b.text || '').join('');
  text = text.replace(/```json|```/g, '').trim();
  const stripTrailingCommas = (t) => t.replace(/,(\s*[}\]])/g, '$1');
  const variants = [];
  const m = text.match(/\[[\s\S]*\]/);
  if (m) variants.push(m[0], stripTrailingCommas(m[0]));
  variants.push(text, stripTrailingCommas(text));
  let parseErr;
  for (const v of variants) {
    try { return JSON.parse(v); } catch (e) { parseErr = e; }
  }
  console.error('Unparseable model output (first 500 chars):', text.slice(0, 500));
  throw new Error('Could not parse model JSON: ' + (parseErr && parseErr.message));
}

async function runTwoPass(apiKey, p, needsAid, basePrompt, sort) {
  // Pass 1 — fast model proposes a candidate pool (names only).
  const candidates = await callClaudeForJson(apiKey, 'claude-haiku-4-5-20251001', buildCandidatePrompt(p, sort), 1500);
  if (!Array.isArray(candidates) || candidates.length < 10) {
    throw new Error('Pass 1 returned too few candidates');
  }
  const pool = candidates.slice(0, 18).map((c) => ({
    name: String((c && (c.name || c.school)) || '').trim(),
    location: [c && c.city, c && c.state].filter(Boolean).join(', '),
  })).filter((c) => c.name);
  if (pool.length < 10) throw new Error('Pass 1 produced too few valid names');

  // Attach REAL Scorecard data to every candidate (parallel).
  const datas = await Promise.allSettled(pool.map((c) => fetchScorecard(c, apiKey)));
  const student = parseStudentTest(p);
  const studentPostal = US_POSTAL_BY_NAME[String((p && p.location) || '').trim()] || '';
  const lines = pool.map((c, i) => {
    const d = datas[i].status === 'fulfilled' ? datas[i].value : null;
    const loc = c.location ? ' (' + c.location + ')' : '';
    if (!d) return `- ${c.name}${loc}: (no verified data found)`;
    const admit = d.admitRate != null ? Math.round(d.admitRate * 100) + '% admit' : 'admit n/a';
    const sat = (d.sat25 != null && d.sat75 != null) ? `, SAT ${d.sat25}-${d.sat75}` : '';
    const act = (d.act25 != null && d.act75 != null) ? `, ACT ${d.act25}-${d.act75}` : '';
    const size = d.size != null ? `, ${d.size.toLocaleString()} ugrad` : '';
    const net = pickNetPrice(d, needsAid, p && p.income);
    const sticker = pickStickerTuition(d, studentPostal);
    const cls = classifyAdmissibility(student, d);
    return `- ${c.name}${loc}: ${admit}${sat}${act}${size}${sticker ? ', ' + sticker.label.toLowerCase() + ' sticker ~$' + fmtK(sticker.value) + '/yr' : ''}${net ? ', net ~$' + fmtK(net.value) + '/yr' : ''}${cls ? ', looks ' + cls : ''}`;
  });

  const poolText = 'VERIFIED CANDIDATE POOL (current College Scorecard data). Choose your final 10 FROM THIS POOL ONLY, using these REAL numbers for cost / size / admit rate / admissibility — do not substitute remembered figures. Sticker prices shown are already residency-correct for this specific student:\n'
    + lines.join('\n') + '\n\n';

  // Pass 2 — strong model makes the final, data-driven selection.
  return await callClaudeForJson(apiKey, 'claude-opus-4-5', poolText + basePrompt, 8000);
}

// Compact prompt for the candidate-shortlist pass (names only).
function buildCandidatePrompt(p, sort) {
  return `You are a US college expert. A student is using the Next4 card-sort matcher. Propose ~16 REAL US colleges that plausibly fit, respecting the hard filters. Return ONLY a JSON array of objects { "name": "Full Official Name", "city": "City", "state": "ST" } — no prose, no markdown.

STUDENT: home state ${p.location || '?'}, GPA ${p.gpa || '?'}${p.gpaScale ? ' (' + p.gpaScale + ')' : ''}, test ${p.testType || '?'} ${p.testScore || ''}, budget ${p.budget || '?'}, major ${p.major || '?'}, grade ${p.grade || '?'}.
MUST HAVE: ${(sort.mustHave || []).join(', ') || 'none'}
WOULD LIKE: ${(sort.wouldLike || []).join(', ') || 'none'}
WOULD RATHER NOT: ${(sort.preferNot || []).join(', ') || 'none'}
NOT FOR ME (exclude): ${(sort.dontLike || []).join(', ') || 'none'}
${sort.dimensionSection || ''}
Respect the hard filters: region/location cards, college size, intended-major strength, weather (no snowy states if "Snow" is Not For Me), and EVERY must-have. Include a realistic spread from likely to reach. Names must be exact and real so they can be looked up in a database.`;
}

// ============================================================================
// BEA REGIONAL PRICE PARITIES (state cost-of-living, free api.data via BEA API)
// One call returns RPP for every state (100 = US average, lower = cheaper). Used
// only for the "Low Cost of Living Area" card. No-op without BEA_API_KEY.
// Docs: https://apps.bea.gov/api/  (dataset Regional, table SARPP, line 1 = all items)
// ============================================================================
const US_POSTAL_BY_NAME = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO',
  'Connecticut':'CT','Delaware':'DE','District of Columbia':'DC','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY',
  'Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN',
  'Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
  'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH',
  'Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC',
  'South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA',
  'Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
};

async function fetchStateRPP(beaKey) {
  if (!beaKey) return null;
  const url = 'https://apps.bea.gov/api/data?&UserID=' + encodeURIComponent(beaKey)
    + '&method=GetData&datasetname=Regional&TableName=SARPP&LineCode=1&GeoFips=STATE&Year=LAST1&ResultFormat=JSON';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let json;
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return null;
    json = await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const rows = json && json.BEAAPI && json.BEAAPI.Results && json.BEAAPI.Results.Data;
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const row of rows) {
    const postal = US_POSTAL_BY_NAME[String(row.GeoName || '').trim()];
    const val = parseFloat(String(row.DataValue || '').replace(/[^0-9.]/g, ''));
    if (postal && !Number.isNaN(val)) out[postal] = Math.round(val);
  }
  return Object.keys(out).length ? out : null;
}

function buildRppSection(rppMap) {
  if (!rppMap || !Object.keys(rppMap).length) return '';
  const entries = Object.entries(rppMap).sort((a, b) => a[1] - b[1]).map(([st, v]) => `${st} ${v}`).join(', ');
  return '\nCOST OF LIVING by state (BEA Regional Price Parities; 100 = US average, lower = cheaper). For the "Low Cost of Living Area" card, a school qualifies only if its state RPP is below ~97; never credit a high-RPP state:\n' + entries + '\n';
}
