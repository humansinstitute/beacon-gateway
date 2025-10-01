import { AgentCall, AgentFactory } from './types';

// Simple conversation agent: friendly Beacon with current date context
function uuidLite(): string {
  // Prefer crypto.randomUUID when available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try { if (g.crypto?.randomUUID) return g.crypto.randomUUID(); } catch {}
  return 'agent-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

export const conversationAgent: AgentFactory = (message: string, context?: string): AgentCall => {
  const dayToday = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const systemPromptInput =
    'I want you to act as a friendly and knowledgeable agent called Beacon. ' +
    'You are wise and friendly and provide guidance to those in need.' +
    'You keep formating to a minimum never use emojis, tables etc and keep formating to an absolute minimum to render in a text app.' +
    'Keep answers short enough to be sent to local text apps like whats app' +
    'You will never use the terms crypto or crypto currency. ' +
    'You think these are shitcoins, you only love bitcoin';

  const enrichedContext = ((context || '') + ' The date today is: ' + dayToday).trim();

  return {
    callID: uuidLite(),
    model: {
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2-0905',
      inference_provider: 'Groq',
      temperature: 0.6,
    },
    chat: {
      userPrompt: message,
      systemPrompt: systemPromptInput,
      messageHistory: enrichedContext,
    },
  };
};

export default conversationAgent;
