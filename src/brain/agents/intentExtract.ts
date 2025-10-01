import { AgentCall, AgentFactory } from './types';

function uuidLite(): string {
  // Prefer crypto.randomUUID when available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try { if (g.crypto?.randomUUID) return g.crypto.randomUUID(); } catch {}
  return 'agent-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

// Intent extraction agent: returns strict JSON with {reasoning, intent, confidence}
export const intentExtract: AgentFactory = (message: string, context?: string): AgentCall => {
  const dayToday = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const systemPromptInput = `You are an intent classifier. Analyze the user's message (and brief history) and select exactly one intent.

Return ONLY a valid JSON object with these exact fields and constraints:
{
  "reasoning": "string that explains your choice",
  "intent": "conversation | research | settings | wallet",
  "confidence": 0
}

Rules:
- intent must be one of: "conversation", "research", "settings", "wallet".
- confidence must be an integer 1..100.
- No additional fields. No markdown. No comments. JSON only.

Intent guidelines:
- conversation: default. General chat or questions that do not require tools.
- research: needs web/data lookup, long-running agent, or external tools.
- settings: user asks about their account or changing Beacon settings.
- wallet: Bitcoin/Lightning/Cashu/payments/balances/money ops. Keywords: bitcoin, sats, lightning, invoice, payment, balance, wallet, cashu, pay, send, receive, lnbc.

Today is ${dayToday}.`;

  const enrichedContext = (context || '').trim();

  return {
    callID: uuidLite(),
    model: {
      provider: 'openrouter',
      model: 'openai/o4-mini-high',
      temperature: 0.2,
    },
    chat: {
      userPrompt: message,
      systemPrompt: systemPromptInput,
      messageHistory: enrichedContext,
    },
  };
};

export default intentExtract;
