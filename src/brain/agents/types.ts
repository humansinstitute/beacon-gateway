// Shared agent type definitions for brain quick responses

export type AgentProvider = 'openrouter';

export interface AgentModelConfig {
  provider: AgentProvider; // currently only 'openrouter' supported in transport
  model: string; // e.g., 'openai/gpt-oss-120b'
  inference_provider?: string; // Optional preferred inference provider (e.g., 'Groq')
  temperature?: number; // 0..1
}

export interface AgentChatConfig {
  userPrompt: string; // the user's latest message
  systemPrompt: string; // system instruction
  messageHistory?: string; // optional prior context as a string
}

export interface AgentCall {
  callID: string;
  model: AgentModelConfig;
  chat: AgentChatConfig;
}

export type AgentFactory = (message: string, context?: string) => Promise<AgentCall> | AgentCall;
