export type AnalystDecision = {
  isContinue: boolean;
  conversationId: string | null;
  reasoning?: string | null;
};

export function parseAnalystJson(raw: string): AnalystDecision | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip markdown code fences
  if (s.startsWith('```')) {
    // remove first line fence and optional language
    s = s.replace(/^```[a-zA-Z0-9_-]*\n?/, '');
    // remove trailing fence
    s = s.replace(/\n?```\s*$/, '');
  }
  // Extract JSON object substring
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonPart = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(jsonPart);
    const result = normalizeAnalystObject(obj);
    return result;
  } catch {
    return null;
  }
}

function normalizeAnalystObject(obj: any): AnalystDecision {
  // Accept both isContinue and isNew forms
  let isContinue: boolean | null = null;
  if (typeof obj?.isContinue === 'boolean') {
    isContinue = obj.isContinue;
  } else if (typeof obj?.isNew === 'boolean') {
    isContinue = !obj.isNew;
  }
  if (isContinue == null) isContinue = false;

  // Accept conversationId/threadID/conversationRef
  let cid: any = obj?.conversationId ?? obj?.threadID ?? obj?.conversationRef ?? null;
  if (cid === '0000') cid = null;
  if (cid != null) cid = String(cid);

  const reasoning = typeof obj?.reasoning === 'string' ? obj.reasoning : null;
  return { isContinue, conversationId: cid, reasoning };
}

