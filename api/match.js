export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get the API key from Vercel environment variables (never exposed to the browser)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { mustHave, wouldLike, dontCare, preferNot, dontLike } = req.body;

    const prompt = `You are an expert college counselor with deep knowledge of US colleges. A student completed the College 360 preference card sort. Based on their selections, recommend their top 8 best-fit colleges.

STUDENT PREFERENCES:
MUST HAVE (highest priority, deal-maker): ${mustHave.join(', ') || 'none'}
WOULD LIKE (high priority): ${wouldLike.join(', ') || 'none'}
DON'T CARE (neutral): ${dontCare.join(', ') || 'none'}
WOULD PREFER NOT (negative weight): ${preferNot.join(', ') || 'none'}
DON'T LIKE AT ALL (deal-breaker): ${dontLike.join(', ') || 'none'}

Return ONLY valid JSON — no markdown, no explanation, no backticks. Return a JSON array of 8 school objects. Each object must have:
- "name": full official school name
- "location": city, state
- "fitPercent": integer 50-99 (realistic fit score based on preferences)
- "tags": array of 3-5 short strings (reasons for match, e.g. "Strong CS", "City campus")
- "why": 1-2 sentence personalized explanation of why this school fits this specific student

Order by fitPercent descending. Be realistic — use actual colleges. Weight must-haves heavily. Let deal-breakers eliminate schools. Recommend a mix of reach, match, and safety schools.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
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
