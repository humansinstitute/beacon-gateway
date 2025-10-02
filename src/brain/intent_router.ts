// intent_router.ts
// Intent routing with slash-command overrides and LLM-based classification.

import { quickResponseWithAgent } from './callAI.util';
import intentExtract from './agents/intentExtract';
import { getEnv } from '../types';

export type IntentRoute =
  | { type: 'wingman'; text: string }
  | { type: 'wallet'; text: string }
  | { type: 'settings' }
  | { type: 'default'; text: string };

function parseSlashOverride(message: string): IntentRoute | null {
  const original = (message || '').trim();
  if (!original) return { type: 'default', text: '' };
  const m = original.match(/^\s*(\/[a-zA-Z]+)\b\s*(.*)$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (cmd === '/talk') return { type: 'default', text: rest };
  if (cmd === '/think') return { type: 'wingman', text: rest };
  if (cmd === '/wallet') return { type: 'wallet', text: rest };
  if (cmd === '/settings') return { type: 'settings' };
  // Default: any other slash commands route to wallet (no AI intent)
  return { type: 'wallet', text: original };
}

export async function routeIntent(message: string, context?: string): Promise<IntentRoute> {
  const text = (message || '').trim();
  if (!text) return { type: 'default', text: '' };

  // 1) Slash-command overrides
  const override = parseSlashOverride(text);
  if (override) {
    const cmd = text.split(/\s+/)[0];
    console.log(`[intent] override: ${cmd} -> ${override.type}`);
    return override;
  }

  // 2) LLM intent extraction
  let intent = 'conversation';
  let confidence = 0;
  let reasoning: string | undefined;
  try {
    const raw = await quickResponseWithAgent(intentExtract, text, context);
    // Try to locate JSON object (in case model adds extra tokens)
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const jsonStr = (start !== -1 && end !== -1 && end > start) ? raw.slice(start, end + 1) : raw;
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed.intent === 'string') intent = String(parsed.intent);
    if (parsed && typeof parsed.confidence === 'number') confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    if (parsed && typeof parsed.reasoning === 'string') reasoning = parsed.reasoning;
    const preview = (reasoning || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`[intent] analysis complete: intent=${intent} confidence=${confidence} reason="${preview}"`);
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error(`[intent] analysis error: ${msg}`);
  }

  const threshold = Number(getEnv('INTENT_CONFIDENCE_THRESHOLD', '60')) || 60;
  const lowConfidence = confidence > 0 && confidence < threshold;

  if (intent === 'research' && !lowConfidence) return { type: 'wingman', text };
  if (intent === 'wallet' && !lowConfidence) return { type: 'wallet', text };
  if (intent === 'settings' && !lowConfidence) return { type: 'settings' };
  // Fallback to conversation/default
  return { type: 'default', text };
}
