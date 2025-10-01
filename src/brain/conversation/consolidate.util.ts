import { getConversationMessageCount, getConversationMessages, getConversationState, setConversationState } from '../../db';
import { quickResponseWithAgent } from '../callAI.util';
import convConsolidateAgent from '../agents/convConsolidate';

export type ConsolidationResult = {
  summary: string | null;
  deltaSinceSummary: number;
};

const MAX_SOURCE_MESSAGES = 60; // cap source size
const MAX_SUMMARY_CHARS = 2500; // max length guard

export async function maybeConsolidate(conversationId: string): Promise<ConsolidationResult> {
  const count = getConversationMessageCount(conversationId);
  const state = getConversationState(conversationId);
  const prevCount = state?.messageCount ?? 0;
  const delta = Math.max(0, count - prevCount);

  // Consolidate every 4 messages or when no summary exists
  if (!state || delta >= 4) {
    // Build a bounded source history block (oldest->newest)
    const items = getConversationMessages(conversationId, MAX_SOURCE_MESSAGES);
    let source = items
      .map((m) => {
        const role = m.direction === 'inbound' ? 'user' : 'beacon';
        const text = (m.content?.text || '').toString();
        return `${role}: ${text}`.trim();
      })
      .filter((s) => s.length > 0)
      .join('\n');
    if (source.length > 12_000) source = source.slice(-12_000);

    const context = state?.summary ? `Previous summary:\n${state.summary}\n---\n` : '';
    const userPrompt = `${context}Please consolidate the following conversation transcript into a concise state summary under ${MAX_SUMMARY_CHARS} characters.\n\nTranscript:\n${source}`;
    try {
      const summary = (await quickResponseWithAgent(convConsolidateAgent, userPrompt, undefined)).trim();
      const clipped = summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) : summary;
      setConversationState(conversationId, clipped, count);
      return { summary: clipped, deltaSinceSummary: 0 };
    } catch (e) {
      return { summary: state?.summary ?? null, deltaSinceSummary: delta };
    }
  }

  // No consolidation needed; return existing summary
  return { summary: state.summary, deltaSinceSummary: delta };
}

