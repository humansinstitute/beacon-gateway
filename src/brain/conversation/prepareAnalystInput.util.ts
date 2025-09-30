import type { RecentConversation } from './recentConv.util';

export function buildAnalystUserPrompt(params: {
  messageText: string;
  userNpub: string | null | undefined;
  recent: RecentConversation[];
  maxMessages?: number;
}): { userPromptString: string; knownConversationIds: Set<string> } {
  const messageText = (params.messageText || '').toString();
  const userNpub = params.userNpub ? String(params.userNpub) : '';
  const maxMessages = typeof params.maxMessages === 'number' ? params.maxMessages : 10;

  const knownIds = new Set<string>();
  const history: Array<{ conversationId: string; messages: string[] }> = [];

  for (const conv of params.recent) {
    const msgs: string[] = [];
    for (const m of conv.messages) {
      const t = (m.text || '').trim();
      if (!t) continue;
      msgs.push(`${m.direction}: ${t}`);
      if (msgs.length >= maxMessages) break;
    }
    if (msgs.length > 0) {
      knownIds.add(conv.conversationId);
      history.push({ conversationId: conv.conversationId, messages: msgs });
    }
  }

  const payload = {
    message: messageText,
    conversatonHistory: { // note: matches the agent's current prompt spelling
      user: userNpub,
      conversations: history,
    },
  };

  const userPromptString = JSON.stringify(payload);
  return { userPromptString, knownConversationIds: knownIds };
}

