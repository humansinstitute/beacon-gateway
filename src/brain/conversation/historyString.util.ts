import { getConversationMessages } from '../../db';

// Build a compact assistant-style history string using the last N messages.
// Maps inbound -> "user: <text>" and outbound -> "assistant: <text>".
export function buildHistoryStringFromConversation(conversationId: string, lastN = 5): string | null {
  if (!conversationId) return null;
  const all = getConversationMessages(conversationId, 1000);
  if (!all || all.length === 0) return null;
  const slice = all.slice(-Math.max(1, lastN));
  const parts: string[] = [];
  for (const m of slice) {
    const t = (m?.content?.text || '').toString().trim();
    if (!t) continue;
    const role = m.direction === 'inbound' ? 'user' : 'assistant';
    parts.push(`${role}: ${t}`);
  }
  if (parts.length === 0) return null;
  return `MessageHistory: ${parts.join(' | ')}`;
}

