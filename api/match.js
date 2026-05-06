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

    // Build student profile context from intake form answers
    const profile = studentProfile || {};
    const profileContext = `
STUDENT BACKGROUND:
- Current location: ${profile.location || 'Not specified'}
- Current school: ${profile.school || 'Not specified'}
- GPA range: ${profile.gpa || 'Not specified'}
- School type preference: ${profile.schoolType || 'Not specified'}`;

    const prompt = `You are an expert college counselor with encyclopedic, fact-based knowledge of US colleges and universities. A student has completed the College 360 preference card sort. Your job is to recommend their top 8 best-fit colleges with extreme precision and accuracy.

${profileContext}

STUDENT CARD SORT PREFERENCES:
MUST HAVE (deal-maker — school must satisfy these or it cannot be recommended): ${mustHave.join(', ') || 'none'}
WOULD LIKE THIS (high priority — strongly weight these in scoring): ${wouldLike.join(', ') || 'none'}
DOESN'T MATTER (neutral): ${dontCare.join(', ') || 'none'}
WOULD RATHER NOT (negative weight — penalize schools with these traits): ${preferNot.join(', ') || 'none'}
NOT FOR ME (deal-breaker — automatically disqualify any school strongly associated with these): ${dontLike.join(', ') || 'none'}

STUDENT PROFILE RULES:
- Use the student's current GPA to calibrate reach vs. match vs. safety schools. A 3.5+ GPA student should have at least 2 selective schools. A 2.5-3.0 GPA student should have mostly accessible schools.
- Use the student's current state to understand proximity preferences if location cards were sorted.
- If student selected Community College or Trade/Certification, prioritize those school types. Do not recommend large research universities to a student who said Community College.
- If student selected 4-Year University, do not recommend community colleges.

ACCURACY RULES — follow all of these strictly:

LOCATION: Only recommend schools physically located in the student's preferred region.
- Rocky Mountains = CO, ID, MT, UT, WY
- West Coast = CA, OR, WA, NV, HI, AK
- Southeast = AL, AR, FL, GA, KY, LA, MS, NC, SC, TN, VA, WV
- Mid-Atlantic = DE, MD, NJ, NY, PA, DC
- New England = CT, ME, MA, NH, RI, VT
- Great Lakes = MI, IL, IN, OH, WI
- Plains = IA, KS, MN, MO, NE, ND, SD
- Southwest = AZ, NM, OK, TX
If the student marked a region as Not For Me, never recommend a school from that region.

SIZE: Match accurately based on undergraduate enrollment.
- Small College = under 3,000 undergrads
- Medium Sized College = 3,000 to 15,000 undergrads
- Large College = over 15,000 undergrads

ACADEMICS: Only recommend a school for a specific major if that school is genuinely well-known for that program.

CULTURE & IDENTITY:
- HBCU: only recommend schools officially designated as Historically Black Colleges and Universities
- Hispanic Serving Institution: only recommend schools with official HSI federal designation
- Women Only: only recommend actual women's colleges
- Religious Campus: only recommend schools with a genuine active religious identity
- LGBTQ+ Friendly: only recommend schools with documented inclusive policies
- Conservative Campus: only recommend schools widely known for conservative student culture
- Party School: only recommend schools with a documented, well-known party culture

WEATHER: If student marked Snow as Not For Me, never recommend schools in MN, WI, VT, ME, NH, ND, SD, MI, upstate NY. If Warm Weather is Must Have, only recommend schools in FL, TX, AZ, CA, HI, or other warm-climate states.

FIT SCORING — be honest and precise:
- 90-97%: matches nearly all must-haves, no deal-breakers
- 75-89%: matches most must-haves with minor gaps
- 60-74%: matches some preferences but notable mismatches
- 52-59%: included for diversity but has meaningful gaps
Never give above 80% unless the school genuinely matches the majority of top priorities.

EXPLANATION: The "why" field must cite specific, verifiable facts directly tied to the student's stated preferences. Never use generic phrases like "great academics" or "vibrant campus life." Be specific: cite enrollment size, known programs, location type, culture, athletics, or cost profile.

SCHOOL DIVERSITY: Include a mix of:
- At least 2 nationally recognized universities
- At least 2 strong regional schools the student may not have considered
- At least 1 smaller or lesser-known school that is a genuine hidden gem fit
- Schools across different price points

Return ONLY valid JSON — no markdown, no explanation, no backticks, no preamble of any kind.
Return a JSON array of exactly 8 school objects. Each object must have:
- "name": full official school name
- "location": city, state (e.g. "Ann Arbor, MI")
- "fitPercent": honest integer between 52 and 97
- "tags": array of exactly 4 short factual strings explaining the match
- "why": exactly 2 sentences. Sentence 1: cite 2-3 specific verifiable facts connecting this school to the student's preferences. Sentence 2: one honest caveat or important thing to know about this school.

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
