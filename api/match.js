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

    const profileContext = `
STUDENT PROFILE (use this to calibrate every recommendation):
- Home state: ${p.location || 'Not specified'}
- GPA range: ${p.gpa || 'Not specified'}
- Standardized testing: ${p.testType || 'Not specified'}${p.testScore && p.testScore !== 'N/A' ? ` (Score: ${p.testScore})` : ''}
- Annual tuition budget: ${p.budget || 'Not specified'}
- Intended major: ${p.major || 'Not specified'}
- Grade level: ${p.grade || 'Not specified'}`;

    const prompt = `You are an expert college counselor with encyclopedic, fact-based knowledge of US colleges and universities. A student has completed the Next4 preference card sort. Your job is to recommend their top 8 best-fit colleges with extreme precision and accuracy.

${profileContext}

STUDENT CARD SORT PREFERENCES:
MUST HAVE (deal-maker — school must satisfy these or it cannot be recommended): ${mustHave.join(', ') || 'none'}
WOULD LIKE THIS (high priority — strongly weight these in scoring): ${wouldLike.join(', ') || 'none'}
DOESN'T MATTER (neutral): ${dontCare.join(', ') || 'none'}
WOULD RATHER NOT (negative weight — penalize schools with these traits): ${preferNot.join(', ') || 'none'}
NOT FOR ME (deal-breaker — automatically disqualify any school strongly associated with these): ${dontLike.join(', ') || 'none'}

PROFILE-BASED CALIBRATION RULES (apply BEFORE looking at card sort):

ADMISSIBILITY (use GPA + test score together):
- GPA 4.1+ with SAT 1450+ or ACT 33+: include 2-3 highly selective schools (acceptance rate under 20%)
- GPA 3.6-4.0 with SAT 1300-1450 or ACT 28-32: focus on selective and mid-selective (acceptance 20-50%)
- GPA 3.1-3.5 with SAT 1100-1290 or ACT 22-27: focus on accessible schools (acceptance 50-80%), 1-2 reach max
- GPA 2.6-3.0: focus on accessible/open admission schools (acceptance 70%+)
- GPA 2.0-2.5: prioritize accessible schools, community college transfer pathways
- GPA 1.6-1.9: focus heavily on open admission schools, community colleges, schools with strong academic support and transfer pathways
- GPA 1.5 and below: prioritize community colleges, trade schools, certification programs, and schools with extensive academic support
- Test-optional or no scores: rely on GPA alone, lean conservative on selectivity

BUDGET FILTERING (hard filter):
- Under $15,000/year: prioritize in-state public universities, community colleges, schools with major scholarships
- $15,000-$30,000/year: in-state publics, some out-of-state publics with good aid, private schools that meet full need
- $30,000-$50,000/year: most public universities, private schools with strong need-based aid
- $50,000-$70,000/year: full range of private universities and elite publics
- $70,000+/year: any school, no cost filter
- Needs significant financial aid: prioritize schools with strongest aid (Ivies, top liberal arts colleges, large publics with aid)

MAJOR PRIORITIZATION:
- If specific major selected: only recommend schools genuinely strong in that field
- Engineering: only ABET-accredited engineering programs
- Pre-Med: only schools with strong pre-med advising and medical school placement
- Business: only accredited business schools or strong undergrad business programs
- Nursing: only CCNE or ACEN-accredited nursing programs
- Veterinary Science / Pre-Vet: only schools with strong animal science and pre-vet advising
- Undecided: prioritize schools with strong general academics and ability to explore many majors

GRADE LEVEL CONTEXT:
- Freshman/Sophomore: early exploration — wider variety to broaden horizons
- Junior: active list building — realistic future application list
- Senior: final list building — only schools they could genuinely apply to and afford
- Other: balance broadly

ACCURACY RULES — follow strictly:

LOCATION: Only recommend schools physically located in preferred regions if location cards were sorted.
- Rocky Mountains = CO, ID, MT, UT, WY
- West Coast = CA, OR, WA, NV, HI, AK
- Southeast = AL, AR, FL, GA, KY, LA, MS, NC, SC, TN, VA, WV
- Mid-Atlantic = DE, MD, NJ, NY, PA, DC
- New England = CT, ME, MA, NH, RI, VT
- Great Lakes = MI, IL, IN, OH, WI
- Plains = IA, KS, MN, MO, NE, ND, SD
- Southwest = AZ, NM, OK, TX
If region marked Not For Me, never recommend schools from that region.

SIZE:
- Small College = under 3,000 undergrads
- Medium Sized College = 3,000 to 15,000 undergrads
- Large College = over 15,000 undergrads

CULTURE & IDENTITY (now in Campus Culture):
- HBCU: only schools officially designated as Historically Black Colleges and Universities
- Hispanic Serving Institution: only schools with official HSI federal designation
- Women Only: only actual women's colleges
- Religious Campus: only schools with active religious identity
- LGBTQ+ Friendly: only schools with documented inclusive policies
- Conservative Campus: only schools widely known for conservative student culture
- Party School: only schools with documented party culture
- Active International Student Community: only schools with 10%+ international enrollment
- Tech / Startup Culture: schools like Stanford, MIT, CMU, Georgia Tech, Northeastern
- Strong Arts & Music Scene: schools with strong undergraduate arts presence

OUTCOMES (in Resources & Support):
- High Job Placement Rate: only schools with documented 85%+ placement within 6 months of graduation
- Direct Admit to Major: schools where students are admitted directly into competitive majors (vs. internal application)
- On-Campus Recruiting / Career Fairs: schools where major employers (Big 4, FAANG, finance) actively recruit
- Community College Transfer Pathway: schools with strong articulation agreements with community colleges
- Required Internships: schools that require internships for graduation (Northeastern, Drexel, Cincinnati, etc.)

ACADEMIC FLEXIBILITY (in Learning Environment):
- Easy to Change Majors: schools known for flexible major switching without falling behind
- Double Major Friendly: schools where double majoring is logistically supported
- Senior Thesis or Capstone Required: schools requiring substantial final projects

WEATHER: If Snow is Not For Me, never recommend schools in MN, WI, VT, ME, NH, ND, SD, MI, upstate NY. If Warm Weather is Must Have, only schools in FL, TX, AZ, CA, HI.

QUALITY-WEIGHTING RULE (apply to all Must Have and Would Like This cards):
When a student marks a card as "Must Have" or "Would Like This," do not simply confirm the school HAS that feature — weight toward schools that are genuinely EXCEPTIONAL or nationally recognized for it. For example, if "Community Service" is a Must Have, prioritize schools famous for service-learning (e.g. Tulane, Berea). If "Clubs" is a Must Have, prioritize schools with extraordinary student organization ecosystems. If "Research Opportunities" is a Must Have, prioritize schools with strong undergraduate research funding and output. The strength of the preference should map to the strength/reputation of that feature at the recommended school, not just its existence.

FIT SCORING:
- 90-97%: matches profile (GPA/budget/major) AND nearly all card must-haves
- 75-89%: matches profile and most card must-haves with minor gaps
- 60-74%: matches profile but only some card preferences
- 52-59%: included for diversity but has notable gaps
Never give above 80% unless school genuinely matches majority of profile filters AND card priorities.

EXPLANATION: The "why" field must cite specific, verifiable facts directly tied to the student's profile AND preferences. Reference their GPA fit, budget fit, major strength, and specific cultural/outcome cards when relevant. Never use generic phrases like "great academics."

SCHOOL DIVERSITY: Include a mix of:
- At least 2 nationally recognized universities
- At least 2 strong regional schools the student may not have considered
- At least 1 smaller or lesser-known school that is a genuine hidden gem fit
- Schools across different price points within budget range

Return ONLY valid JSON — no markdown, no explanation, no backticks, no preamble.
Return a JSON array of exactly 8 school objects. Each object must have:
- "name": full official school name
- "location": city, state (e.g. "Ann Arbor, MI")
- "fitPercent": honest integer between 52 and 97
- "tags": array of exactly 4 short factual strings explaining the match (include cost tier, size, key program, and one cultural/location fact)
- "why": exactly 2 sentences. Sentence 1: cite 2-3 specific verifiable facts connecting this school to the student's profile and preferences. Sentence 2: one honest caveat or important thing to know about this school.

Order by fitPercent descending. Be rigorous, accurate, and specific.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2500,
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
    const schools = JSON.parse(text);

    return res.status(200).json({ schools });

  } catch (error) {
    console.error('Backend error:', error);
    return res.status(500).json({ error: error.message });
  }
}
