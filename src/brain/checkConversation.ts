import { getMessageById } from '../db';
import { getRecentConversationsByNpub } from './conversation/recentConv.util';
import { buildAnalystUserPrompt } from './conversation/prepareAnalystInput.util';
import { parseAnalystJson } from './conversation/parseAnalystJson.util';
import { quickResponseWithAgent } from './callAI.util';
import conversationAnalyst from './agents/conversationAnalyst';

export type CheckConversationInput = {
  replyToMessageId?: string | null;
  userNpub?: string | null;
  messageText?: string | null;
};

export type CheckConversationResult = {
  conversationExists: boolean;
  conversationId: string;
};

export async function checkConversation(input: CheckConversationInput): Promise<CheckConversationResult> {
  // If we have an internal parent message id, inherit its conversation
  if (input.replyToMessageId) {
    const parent = getMessageById(input.replyToMessageId);
    if (parent?.conversationId) {
      return { conversationExists: true, conversationId: parent.conversationId };
    }
  }
  // New conversation decision: consult analyst if we have user npub and a message text
  const messageText = (input.messageText || '').trim();
  const userNpub = input.userNpub || null;
  if (userNpub && messageText) {
    try {
      const recent = getRecentConversationsByNpub(userNpub);
      const { userPromptString, knownConversationIds } = buildAnalystUserPrompt({
        messageText,
        userNpub,
        recent,
      });
      const raw = await quickResponseWithAgent(conversationAnalyst, userPromptString);
      console.log('[analyst_raw]', raw);
      const parsed = parseAnalystJson(raw);
      console.log('[analyst_parsed]', parsed);
      if (parsed?.isContinue && parsed.conversationId && knownConversationIds.has(parsed.conversationId)) {
        return { conversationExists: true, conversationId: parsed.conversationId };
      }
    } catch (err: any) {
      console.error('[analyst_error]', String(err?.message || err));
    }
  }
  // Fallback: start a new conversation
  const id = genUUID();
  return { conversationExists: false, conversationId: id };
}

function genUUID(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = globalThis as any;
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch {}
  return 'conv-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}
