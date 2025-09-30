import { getMessageById } from '../db';

export type CheckConversationInput = {
  replyToMessageId?: string | null;
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
  // Default: start new conversation
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

