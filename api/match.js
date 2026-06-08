export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { mustHave, wouldLike, dontCare, preferNot, dontLike, studentProfile } = req.body;
    const p = studentProfile || {};

    // Detect whether the student signaled a need for financial aid anywhere in
    // their card sort or profile. Drives net-price (vs sticker-price) evaluation.
    const aidSignals = ['financial aid', 'need significant financial aid', 'needs significant financial aid', 'need-based aid', 'meets full need'];
    const allCards = [...(mustHave || []), ...(wouldLike || [])].map(c => String(c).toLowerCase());
    const budgetStr = String(p.budget || '').toLowerCase();
    const needsAid =
      allCards.some(c => aidSignals.some(s => c.includes(s))) ||
      aidSignals.some(s => budgetStr.includes(s)) ||
      budgetStr.includes('under $15') || budgetStr.includes('significant');

    const profileContext = `
STUDENT PROFILE (use this to calibrate every recommendation):
- Home state: ${p.location || 'Not specified'}
- GPA range: ${p.gpa || 'Not specified'}
- Standardized testing: ${p.testType || 'Not specified'}${p.testScore && p.testScore !== 'N/A' ? ` (Score: ${p.testScore})` : ''}
- Annual budget: ${p.budget || 'Not specified'}
- Intended major: ${p.major || 'Not specified'}
- Grade level: ${p.grade || 'Not specified'}
- Financial-aid need detected: ${needsAid ? 'YES - evaluate affordability on NET price, not sticker price' : 'No explicit aid signal - use stated budget'}`;

    const prompt = `You are an expert college counselor with encyclopedic, fact-based knowledge of US colleges and universities. A student has completed the Next4 preference card sort. Your job is to recommend their top 8 best-fit colleges with extreme precision and accuracy.

${profileContext}

STUDENT CARD SORT PREFERENCES:
MUST HAVE (deal-maker - school must satisfy these or it cannot be recommended): ${(mustHave || []).join(', ') || 'none'}
WOULD LIKE THIS (high priority - strongly weight these in scoring): ${(wouldLike || []).join(', ') || 'none'}
DOESN'T MATTER (neutral): ${(dontCare || []).join(', ') || 'none'}
WOULD RATHER NOT (negative weight - penalize schools with these traits): ${(preferNot || []).join(', ') || 'none'}
NOT FOR ME (deal-breaker - automatically disqualify any school strongly associated with these): ${(dontLike || []).join(', ') || 'none'}

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
TWO INDEPENDENT SYSTEMS - do not let them contradict each other
==================================================================
SYSTEM A - SEARCH AMBITION (how selective the schools you SEARCH should be).
This tells you how high to aim. It does NOT label individual schools.
- GPA 4.1+ with SAT 1450+ or ACT 33+: search includes highly selective schools (admit rate under 20%)
- GPA 3.6-4.0 with SAT 1300-1450 or ACT 28-32: selective and mid-selective (admit 20-50%)
- GPA 3.1-3.5 with SAT 1100-1290 or ACT 22-27: mostly accessible schools (admit 50-80%), a few stretch options
- GPA 2.6-3.0: accessible / broad-access schools (admit 70%+)
- GPA 2.0-2.5: accessible schools, community-college transfer pathways
- GPA 1.6-1.9: open-admission schools, community colleges, schools with strong academic support and transfer pathways
- GPA 1.5 and below: community colleges, trade schools, certification programs, schools with extensive academic support
- Test-optional or no scores: rely on GPA alone, lean conservative on selectivity

SYSTEM B - PER-SCHOOL ADMISSIBILITY CLASSIFICATION (label each result honestly).
SEPARATELY, for EACH school you recommend, compare THIS student's GPA and test scores to THAT school's admitted-student profile (anchor to the school's Common Data Set / College Scorecard / IPEDS) and classify it independently:
- "Likely": student's GPA/test are at or above the school's 75th-percentile admitted profile, and admit rate is not punishing.
- "Target": student's stats fall within the school's middle-50% admitted profile.
- "Reach": student's stats are below the 25th percentile, OR the school's admit rate is under 20% (sub-20% schools are a Reach for everyone, regardless of stats).

These two systems are INDEPENDENT. System A decides how high to aim; System B honestly labels each result. A 4.1-GPA student will still have Reach schools (e.g., sub-20% admit schools) and must also have at least one Likely. Never let the GPA tier override the honest per-school label.
HARD REQUIREMENT: the final list of 8 MUST contain at least 1 "Likely" and at least 1 "Reach", and must NOT be entirely "Reach".

==================================================================
AFFORDABILITY - NET price when aid is needed, sticker otherwise
==================================================================
${needsAid
  ? `This student needs financial aid. Evaluate affordability on ESTIMATED NET PRICE after need-based aid (anchor: College Scorecard net-price-by-income + the school's Net Price Calculator), NOT published sticker tuition.
- ACTIVELY INCLUDE high-sticker schools that meet ~100% of demonstrated need (e.g., Ivies, Stanford, MIT, Amherst, Williams, Pomona, Bowdoin) and well-endowed liberal-arts colleges - for an aided student their net price is often far below an out-of-state public, and excluding them on sticker price alone is a mistake.
- Do NOT exclude a school for a high sticker price if its likely net price fits the student's means. Note the sticker-vs-net distinction in the caveat.`
  : `No explicit aid need was signaled - filter on the student's stated budget against typical cost:
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

CULTURE & IDENTITY (Campus Culture):
- HBCU: only officially designated Historically Black Colleges and Universities
- Hispanic Serving Institution: only schools with official HSI federal designation
- Women Only: only actual women's colleges
- Religious Campus: only schools with active religious identity
- LGBTQ+ Friendly: only schools with documented inclusive policies
- Conservative Campus: only schools widely known for conservative student culture
- Party School: only schools with documented party culture
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
- Easy to Change Majors: schools known for flexible major switching
- Double Major Friendly: schools where double majoring is logistically supported
- Senior Thesis or Capstone Required: schools requiring substantial final projects

SPECIALIZED CARD DATA RULES (newer cards - anchor each to a real source; if unverifiable, hedge in the caveat and do not credit the school):
- Mental Health & Counseling Services: prioritize documented counseling capacity (low student-to-counselor ratio, short wait times, on-staff clinicians); do not credit a school merely for having a counseling center.
- Strong Internship Pipeline: prioritize documented internship participation + employer partnerships (NACE first-destination internship rates, co-op offices, named employer pipelines); distinct from internships built into the major.
- State-of-the-Art Labs & Facilities: prioritize documented recent capital investment + high research/instructional expenditures in the STUDENT'S field (NSF HERD; recent construction); scope to their major, not generic "nice buildings".

WEATHER: If Snow is Not For Me, never recommend schools in MN, WI, VT, ME, NH, ND, SD, MI, upstate NY. If Warm Weather is Must Have, only schools in FL, TX, AZ, CA, HI.

==================================================================
HANDLING MUST HAVE / WOULD LIKE CARDS
==================================================================
QUALITY-WEIGHTING RULE: When a card is "Must Have" or "Would Like This," do not merely confirm the school HAS that feature - weight toward schools genuinely EXCEPTIONAL or nationally recognized for it (e.g. "Community Service" -> Tulane, Berea; "Research Opportunities" -> schools with strong, documented undergraduate research funding/output). The strength of the preference should map to the strength/reputation of that feature at the recommended school.

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
Return a JSON array of exactly 8 school objects, ordered by fitPercent descending. Each object:
- "name": full official school name
- "location": "City, ST" (e.g. "Ann Arbor, MI")
- "fitPercent": honest integer 52-99
- "admissibility": exactly one of "Likely" | "Target" | "Reach"
- "tags": an OBJECT with exactly these four NAMED string fields (named so they can never render out of order):
    - "cost": affordability tier - net price if aid-relevant (e.g. "Net ~$19K/yr after aid" or "In-state ~$12K/yr")
    - "size": size category + approx undergrad enrollment (e.g. "Medium, ~9,400 ugrad")
    - "program": key program strength tied to the student's major/priorities (e.g. "Top-20 ABET Engineering")
    - "fit": admissibility label + admit-rate context (e.g. "Target, ~38% admit")
- "why": exactly 2 sentences. Sentence 1: 2-3 specific, source-anchored facts connecting the school to this student's profile and cards. Sentence 2: one honest caveat (note data-confidence if any figure is approximate).

FINAL SELF-CHECK before returning - verify ALL of these and fix anything that fails:
1. Exactly 8 schools.
2. Valid JSON: no markdown, no backticks, no trailing commas.
3. Every object has name, location, fitPercent (integer 52-99), admissibility, tags{cost,size,program,fit}, and a 2-sentence why.
4. At least 1 school is "Likely" and at least 1 is "Reach"; not all are "Reach".
5. No more than 2 schools from the same state.
6. Every MUST HAVE card is reflected in the recommended schools (schools that fail a MUST HAVE were excluded).
7. Every numeric figure is source-anchored or explicitly hedged as approximate - no fabricated precise stats.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData });
    }

    const data = await response.json();
    let text = data.content.map(b => b.text || '').join('');
    text = text.replace(/```json|```/g, '').trim();

    // Robustly parse the model's JSON. Models occasionally emit a trailing
    // comma, wrap the array in prose, or add code fences. Try progressively
    // more forgiving variants before giving up.
    const stripTrailingCommas = (t) => t.replace(/,(\s*[}\]])/g, '$1');
    const candidates = [];
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) candidates.push(arrayMatch[0]);
    candidates.push(text);

    let schools, parseErr;
    for (const c of candidates) {
      for (const variant of [c, stripTrailingCommas(c)]) {
        try { schools = JSON.parse(variant); break; } catch (e) { parseErr = e; }
      }
      if (schools) break;
    }
    if (!schools) {
      console.error('Unparseable model output (first 500 chars):', text.slice(0, 500));
      throw new Error('Could not parse model JSON: ' + (parseErr && parseErr.message));
    }

    schools = sanitizeSchools(schools);
    return res.status(200).json({ schools });

  } catch (error) {
    console.error('Backend error:', error);
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

  const cleaned = schools.slice(0, 8).map((s) => {
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
