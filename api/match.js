export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { mustHave, wouldLike, dontCare, preferNot, dontLike } = req.body;

    const prompt = `You are an expert college counselor with encyclopedic, fact-based knowledge of US colleges and universities. A student has completed the College 360 preference card sort. Your job is to recommend their top 8 best-fit colleges with extreme precision and accuracy.

STUDENT PREFERENCES:
MUST HAVE (deal-maker — school must satisfy these or it cannot be recommended): ${mustHave.join(', ') || 'none'}
WOULD LIKE (high priority — strongly weight these in scoring): ${wouldLike.join(', ') || 'none'}
NEUTRAL (no weight): ${dontCare.join(', ') || 'none'}
WOULD PREFER NOT (negative weight — penalize schools with these traits): ${preferNot.join(', ') || 'none'}
DON'T LIKE AT ALL (deal-breaker — automatically disqualify any school strongly associated with these): ${dontLike.join(', ') || 'none'}

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
If the student marked a region as Don't Like, never recommend a school from that region.

SIZE: Match accurately based on undergraduate enrollment.
- Small College = under 3,000 undergrads
- Medium College = 3,000 to 15,000 undergrads
- Large College = over 15,000 undergrads

ACADEMICS: Only recommend a school for a specific major if that school is genuinely well-known for that program. Never suggest a school for Engineering if it has no engineering program. Never suggest a school for Nursing if it has no nursing program.

CULTURE & IDENTITY:
- HBCU: only recommend schools officially designated as Historically Black Colleges and Universities by the federal government
- Hispanic Serving Institution: only recommend schools with official HSI federal designation
- Women Only: only recommend actual women's colleges
- Religious Campus: only recommend schools with a genuine active religious identity
- LGBTQ+ Friendly: only recommend schools with documented inclusive policies and active LGBTQ+ communities
- Conservative Campus: only recommend schools widely known for conservative student culture
- Party School: only recommend schools with a documented, well-known party culture
- Greek Life: only recommend schools with active, prominent Greek life

WEATHER: If student marked Snow as Don't Like, never recommend schools in MN, WI, VT, ME, NH, ND, SD, MI, upstate NY, or any other high-snowfall region. If Warm Weather is Must Have, only recommend schools in FL, TX, AZ, CA, HI, or other warm-climate states.

FIT SCORING: Be honest and precise. Do not inflate scores.
- 90-97%: school matches nearly all must-haves and most would-likes with no deal-breakers
- 75-89%: school matches most must-haves with minor gaps
- 60-74%: school matches some preferences but has notable mismatches
- 52-59%: included for diversity of options but has meaningful gaps
Never give a school above 80% unless it genuinely matches the majority of the student's top priorities.

EXPLANATION QUALITY: The "why" field must cite specific, verifiable facts directly tied to the student's stated preferences. Never use generic phrases like "great academics," "vibrant campus life," or "strong community." Be specific: cite enrollment size, known programs, location type, culture, athletics, cost profile, or other concrete attributes.

SCHOOL DIVERSITY: Include a mix of:
- At least 2 nationally recognized universities
- At least 2 strong regional schools the student may not have considered
- At least 1 smaller or lesser-known school that is a genuine hidden gem fit
- Schools across different price points if cost-related cards were sorted

Return ONLY valid JSON — no markdown, no explanation, no backticks, no preamble of any kind.
Return a JSON array of exactly 8 school objects. Each object must have:
- "name": full official school name (e.g. "University of Michigan" not "U of M")
- "location": city, state (e.g. "Ann Arbor, MI")
- "fitPercent": honest integer between 52 and 97
- "tags": array of exactly 4 short factual strings explaining the match (e.g. "45,000 undergrads", "Top-10 Engineering", "Big Ten athletics", "Midwest college town")
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
