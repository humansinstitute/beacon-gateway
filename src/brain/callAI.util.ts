/**
 * callAI.util
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
  /** Optional request timeout ms; defaults to 60000 */
  timeoutMs?: number;
  /** Optional temperature for model (0..1) */
  temperature?: number;
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
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const temperature = opts.temperature;

  // Fixed system prompt requested by user
  const systemPrompt =
    'You are the beacon, please answer the question to the best of your ability but keep the answer short';

  // Abort fetch if it takes too long
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Minimal, structured logging for visibility
  console.log('[callAI] request', {
    model,
    questionPreview: trimmed.slice(0, 120),
    timeoutMs,
  });

  const attempt = async () => {
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
        ...(typeof temperature === 'number' ? { temperature } : {}),
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
    console.log('[callAI] response', { model: data.model, finish_reason: choice?.finish_reason, usage: data.usage });
    if (!content) throw new Error('OpenRouter: empty content in response');
    return content;
  };

  try {
    const started = Date.now();
    try {
      return await attempt();
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (!isAbort) throw err;
      console.warn('[callAI] attempt aborted; retrying once');
      // Reset controller for retry
      clearTimeout(timeout);
      controller.abort();
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), timeoutMs);
      // Re-run attempt with new controller
      // Rebuild request using a small wrapper to substitute signal
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
          ...(typeof temperature === 'number' ? { temperature } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: trimmed },
          ],
        }),
        signal: controller2.signal,
      });
      if (!res.ok) {
        const text = await safeReadText(res);
        throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText}: ${text}`);
      }
      const data = (await res.json()) as OpenRouterChatResponse;
      const choice = data.choices?.[0];
      const content = choice?.message?.content?.trim();
      console.log('[callAI] response', { model: data.model, finish_reason: choice?.finish_reason, usage: data.usage, retryMs: Date.now() - started });
      if (!content) throw new Error('OpenRouter: empty content in response');
      clearTimeout(timeout2);
      return content;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[callAI] error', { message });
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

// -------------------- Agent-driven variant --------------------

import type { AgentCall, AgentFactory } from './agents/types';

/**
 * Calls OpenRouter using an Agent definition. Allows control over model, temperature, and prompts.
 */
export async function quickResponseWithAgent(
  agentFactory: AgentFactory,
  message: string,
  context?: string,
  opts: { apiKey?: string; timeoutMs?: number } = {}
): Promise<string> {
  const agent: AgentCall = await Promise.resolve(agentFactory(message, context));
  if (!agent?.model?.model) throw new Error('quickResponseWithAgent: invalid agent configuration');

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('quickResponseWithAgent: OPENROUTER_API_KEY not set');

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Compose messages from agent config
  const messages: Array<{ role: 'system' | 'assistant' | 'user'; content: string }> = [
    { role: 'system', content: agent.chat.systemPrompt },
  ];
  if (agent.chat.messageHistory) messages.push({ role: 'assistant', content: agent.chat.messageHistory });
  messages.push({ role: 'user', content: agent.chat.userPrompt });

  console.log('[callAI] request', {
    model: agent.model.model,
    temperature: agent.model.temperature,
    questionPreview: agent.chat.userPrompt.slice(0, 120),
    timeoutMs,
  });

  const attempt = async (signal: AbortSignal) => {
    const providerRouting = agent.model.inference_provider
      ? { provider: { order: [agent.model.inference_provider] } }
      : undefined;
    if (agent.model.inference_provider) {
      console.log('[callAI] using inference provider:', agent.model.inference_provider);
    }
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://beacon-gateway',
        'X-Title': 'Beacon Gateway',
      },
      body: JSON.stringify({
        model: agent.model.model,
        ...(typeof agent.model.temperature === 'number' ? { temperature: agent.model.temperature } : {}),
        ...(providerRouting ? providerRouting : {}),
        messages,
      }),
      signal,
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    const data = (await res.json()) as OpenRouterChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();
    console.log('[callAI] response', { model: data.model, finish_reason: choice?.finish_reason, usage: data.usage });
    if (!content) throw new Error('OpenRouter: empty content in response');
    return content;
  };

  try {
    const started = Date.now();
    try {
      return await attempt(controller.signal);
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (!isAbort) throw err;
      console.warn('[callAI] attempt aborted; retrying once');
      clearTimeout(timeout);
      controller.abort();
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), timeoutMs);
      const result = await attempt(controller2.signal);
      clearTimeout(timeout2);
      console.log('[callAI] retry succeeded', { durationMs: Date.now() - started });
      return result;
    }
  } catch (err) {
    const messageErr = err instanceof Error ? err.message : String(err);
    console.error('[callAI] error', { message: messageErr });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
