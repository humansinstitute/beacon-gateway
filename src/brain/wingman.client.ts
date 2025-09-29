import type { BeaconMessage } from '../types';

type WingmanOptions = {
  recipeId?: string;
  dir?: string;
  apiUrl?: string; // default from env WINGMAN_API_URL
  token?: string;  // default from env WINGMAN_API_TOKEN
};

function env(key: string): string | undefined {
  // Supports Bun.env and process.env
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunVal = (typeof (globalThis as any).Bun !== 'undefined' ? (globalThis as any).Bun.env?.[key] : undefined);
  const nodeVal = (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return (bunVal ?? nodeVal) as string | undefined;
}

export async function triggerWingmanForBeacon(
  msg: BeaconMessage,
  opts: WingmanOptions = {}
): Promise<void> {
  const apiUrl = (opts.apiUrl || env('WINGMAN_API_URL') || '').replace(/\/?$/, '/');
  if (!apiUrl) throw new Error('WINGMAN_API_URL not set');

  const token = opts.token ?? env('WINGMAN_API_TOKEN');
  const recipeId = opts.recipeId ?? '58db78dc339f78cc11669abe6ea8d44a';
  const dir = opts.dir ?? '~/code/temp/beacon';

  const text = (msg.source.text || '').trim();
  const prompt = `${text} ---{'beaconID':'${msg.beaconID}'}`;
  const sessionName = `Beacon Session ${msg.beaconID}`;

  const body = {
    recipe_id: recipeId,
    prompt,
    session_name: sessionName,
    dir,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  console.log('[wingman] trigger', { apiUrl, recipeId, sessionName });
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const textRes = await res.text();
  let json: any = null;
  try { json = JSON.parse(textRes); } catch {}
  if (!res.ok) {
    console.error('[wingman] trigger failed', { status: res.status, body: textRes });
    throw new Error(`Wingman trigger failed: HTTP ${res.status}`);
  }
  console.log('[wingman] trigger ok', json || textRes);
}

