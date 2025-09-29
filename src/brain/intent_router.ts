// intent_router.ts
// Minimal intent router with a default AI route.

export type IntentRoute =
  | { type: 'wingman'; responseText: string }
  | { type: 'default' };

// Inspect first 5 words; if any equals 'wingman' (case-insensitive), trigger wingman route.
export function routeIntent(message: string): IntentRoute {
  const text = (message || '').trim();
  if (!text) return { type: 'default' };
  const words = text.split(/\s+/).slice(0, 5);
  const hasWingman = words.some((w) => w.toLowerCase() === 'wingman');
  if (hasWingman) {
    return { type: 'wingman', responseText: 'I can be your wingman anytime' };
  }
  return { type: 'default' };
}

