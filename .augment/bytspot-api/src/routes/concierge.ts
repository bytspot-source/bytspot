import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';
import { optionalAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

// Tighter rate-limit for AI: 20 requests per minute per IP
const conciergeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many concierge requests. Please wait a moment.' },
});

// Lazy-init so missing key doesn't crash startup
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openaiApiKey });
  return _openai;
}

interface VenueContext {
  id: string;
  name: string;
  category: string;
  crowd?: { level: number; label: string; waitMins?: number };
  address?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface QuizAnswers {
  vibe?: string;
  walk?: string;
  group?: string;
}

function buildSystemPrompt(venues: VenueContext[], quiz?: QuizAnswers): string {
  const venueList = venues
    .map(v => {
      const crowd = v.crowd
        ? `${v.crowd.label} (${v.crowd.level}/4)${v.crowd.waitMins ? `, ~${v.crowd.waitMins}m wait` : ''}`
        : 'Unknown';
      return `  • [${v.id}] ${v.name} | ${v.category} | Crowd: ${crowd} | ${v.address ?? 'Midtown ATL'}`;
    })
    .join('\n');

  const userCtx = quiz
    ? `\nUser preferences from onboarding: vibe=${quiz.vibe ?? 'any'}, walk=${quiz.walk ?? 'any'}, group=${quiz.group ?? 'any'}`
    : '';

  return `You are the Bytspot Concierge — a sharp, friendly Atlanta Midtown expert powered by live crowd data.${userCtx}

LIVE venue data right now in Midtown Atlanta:
${venueList || '  (no venue data available — suggest checking back shortly)'}

STRICT RULES:
1. Only recommend venues from the live list above. Never invent venue names.
2. Keep replies conversational, confident, 2-4 sentences. Use 1-2 emojis naturally.
3. Always mention the crowd level when recommending (e.g. "it's pretty quiet right now").
4. For parking or ride questions, mention the Map and Discover tabs in the Bytspot app.
5. You MUST respond with valid JSON only — no markdown, no extra text outside the JSON:
   {"reply": "your message here", "venueIds": ["id1", "id2"]}
6. Include 1-3 venue IDs in venueIds only when making venue recommendations. Use empty array otherwise.
7. If nothing matches well, suggest the closest alternative and be honest about why.
8. You know Atlanta Midtown inside out — be confident and local.`;
}

/** POST /concierge/chat */
router.post('/concierge/chat', conciergeRateLimit, optionalAuth, async (req, res) => {
  const { messages, venues = [], quizAnswers } = req.body as {
    messages: ChatMessage[];
    venues?: VenueContext[];
    quizAnswers?: QuizAnswers;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  if (!config.openaiApiKey) {
    res.status(503).json({ error: 'AI concierge not configured' });
    return;
  }

  try {
    const openai = getOpenAI();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(venues, quizAnswers) },
        ...messages.slice(-10), // keep last 10 turns for context
      ],
      max_tokens: 300,
      temperature: 0.75,
      response_format: { type: 'json_object' },
    });

    const raw =
      completion.choices[0]?.message?.content ??
      '{"reply":"Sorry, I had trouble responding. Try again!","venueIds":[]}';

    let parsed: { reply: string; venueIds: string[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { reply: raw, venueIds: [] };
    }

    res.json({
      reply: parsed.reply ?? "Let me find something great for you...",
      venueIds: Array.isArray(parsed.venueIds) ? parsed.venueIds : [],
    });
  } catch (err: any) {
    console.error('[Concierge] OpenAI error:', err?.message);
    res.status(500).json({ error: 'AI concierge temporarily unavailable' });
  }
});

export default router;

