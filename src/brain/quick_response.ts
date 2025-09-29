/**
 * quick_response
 *
 * Text-only helper to call OpenRouter and get a short answer.
 * - Default model: 'openai/gpt-oss-120b'
 * - System prompt: "You are the beacon, please answer the question to the best of your ability but keep the answer short"
 * - Uses Bun's global fetch (no extra deps)
 */

// Lightweight type for OpenRouter's chat completion response
type OpenRouterChoice = {
  index: number;
  message?: { role: string; content?: string };
  finish_reason?: string;
};

type OpenRouterChatResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenRouterChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type QuickResponseOptions = {
  /** Override model; defaults to 'openai/gpt-oss-120b' */
  model?: string;
  /** Optional API key override; otherwise reads OPENROUTER_API_KEY from env */
  apiKey?: string;
  /** Optional request timeout ms; defaults to 10000 */
  timeoutMs?: number;
};

/**
 * Calls OpenRouter chat completions with a fixed, concise system prompt and returns the model's text.
 */
export async function quickResponse(
  question: string,
  opts: QuickResponseOptions = {}
): Promise<string> {
  const trimmed = (question ?? '').trim();
  if (!trimmed) throw new Error('quickResponse: question is empty');

  // Read API key (explicit option wins)
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('quickResponse: OPENROUTER_API_KEY not set');

  // Default model and timeout
  const model = opts.model ?? 'openai/gpt-oss-120b';
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Fixed system prompt requested by user
  const systemPrompt =
    'You are the beacon, please answer the question to the best of your ability but keep the answer short';

  // Abort fetch if it takes too long
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Minimal, structured logging for visibility
  console.log('[quick_response] request', {
    model,
    questionPreview: trimmed.slice(0, 120),
    timeoutMs,
  });

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://beacon-gateway',
        'X-Title': 'Beacon Gateway',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: trimmed },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText}: ${text}`);
    }

    const data = (await res.json()) as OpenRouterChatResponse;

    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();

    // Log basic completion metadata
    console.log('[quick_response] response', {
      model: data.model,
      finish_reason: choice?.finish_reason,
      usage: data.usage,
    });

    if (!content) throw new Error('OpenRouter: empty content in response');
    return content;
  } catch (err) {
    // Surface concise error and rethrow for caller
    const message = err instanceof Error ? err.message : String(err);
    console.error('[quick_response] error', { message });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reads response text safely (guards against additional await on already consumed body errors)
 */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no-body>';
  }
}

