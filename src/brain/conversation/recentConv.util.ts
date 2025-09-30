import { getDB } from '../../db';

type Direction = 'inbound' | 'outbound';

export type RecentConversation = {
  conversationId: string;
  messages: Array<{
    id: string;
    direction: Direction;
    role: string;
    text: string | null;
    createdAt: number;
  }>;
};

// Returns last 5 conversations (by most recent message) for a given user npub, with all messages.
export function getRecentConversationsByNpub(userNpub: string, limit = 5): RecentConversation[] {
  const db = getDB();
  // Find most recent conversations where any message is associated to this user npub
  const convRows = db
    .query(
      `SELECT conversation_id, MAX(created_at) as last_time
       FROM messages
       WHERE user_npub = ?
       GROUP BY conversation_id
       ORDER BY last_time DESC
       LIMIT ?`
    )
    .all(userNpub, limit) as any[];

  const results: RecentConversation[] = [];
  const msgStmt = db.query(
    `SELECT id, direction, role, content_json, created_at
     FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at ASC`
  );

  for (const row of convRows) {
    const conversationId = String(row.conversation_id);
    const msgs = msgStmt.all(conversationId) as any[];
    const messages = msgs.map((m) => {
      let text: string | null = null;
      try {
        const content = m.content_json ? JSON.parse(m.content_json) : null;
        text = (content?.text ?? null) as string | null;
      } catch {
        text = null;
      }
      return {
        id: String(m.id),
        direction: String(m.direction) as Direction,
        role: String(m.role),
        text,
        createdAt: Number(m.created_at),
      };
    });
    results.push({ conversationId, messages });
  }

  return results;
}
