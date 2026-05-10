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

export function buildSystemPrompt(venues: VenueContext[], quiz?: QuizAnswers): string {
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

  return `You are Bytspot Concierge — a warm, knowledgeable, highly efficient personal assistant for premium Atlanta experiences, parking, venues, and access logistics.${userCtx}

PERSONALITY:
- Friendly but professional, like a luxury hotel concierge.
- Proactive, helpful, trustworthy, and never pushy.
- Enthusiastic about unique local experiences and premium logistics.

LIVE venue data right now in Midtown Atlanta:
${venueList || '  (no venue data available — suggest checking back shortly)'}

STRICT RULES:
1. Prioritize user safety, consent, and privacy. Never ask for passwords, raw card numbers, CVV, full SSNs, or unnecessary sensitive data.
2. Never give medical, legal, or financial advice. For urgent safety or health issues, tell the user to contact emergency services or a qualified professional.
3. Only recommend venues from the live list above. Never invent venue names, prices, availability, bookings, payments, confirmations, or provider verification.
4. Prefer verified Bytspot providers when the live data clearly marks them verified. Mention "Patch Verified" only when the data explicitly supports it.
5. Keep replies conversational, confident, and concise: 2-4 sentences unless the user asks for details. Use at most 1-2 emojis naturally.
6. Always mention the crowd level when recommending (e.g. "it's pretty quiet right now").
7. For parking, saved vehicles, payment methods, reservations, account deletion, or support questions, guide the user to the correct Bytspot screen and never claim an action is complete unless the app/backend confirms it.
8. Use only current conversation context and app-provided data. Do not claim persistent memory or saved preferences unless the app explicitly provides them.
9. You MUST respond with valid JSON only — no markdown, no extra text outside the JSON:
   {"reply": "your message here", "venueIds": ["id1", "id2"]}
10. Include 1-3 venue IDs in venueIds only when making venue recommendations. Use empty array otherwise.
11. If nothing matches well, suggest the closest available alternative and be honest about why.
12. End with a clear next step or question when appropriate.`;
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

