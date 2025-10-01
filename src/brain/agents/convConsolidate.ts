import type { AgentCall, AgentFactory } from './types';

function uuidLite(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try { if (g.crypto?.randomUUID) return g.crypto.randomUUID(); } catch {}
  return 'agent-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

export type ConsolidateParams = {
  priorSummary?: string;
  messagesBlock: string;
  maxChars?: number;
};

export const convConsolidateAgent: AgentFactory = (message: string, context?: string): AgentCall => {
  return {
    callID: uuidLite(),
    model: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2-0905',
      inference_provider: 'Groq',
      temperature: 0.3,
    },
    chat: {
      userPrompt: message,
      systemPrompt: (
        'You are Beacon. Consolidate the conversation into a concise, factual summary capturing key entities, tasks, decisions, and open questions. ' +
        'Do not include chit-chat. Keep under the requested character limit. Use compact bullet points or short paragraphs.'
      ),
      messageHistory: (context || ''),
    },
  };
};

export default convConsolidateAgent;
