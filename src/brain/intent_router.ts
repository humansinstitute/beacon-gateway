// intent_router.ts
// Minimal intent router with a default AI route.

export type IntentRoute =
  | { type: 'wingman' }
  | { type: 'default' }
  | { type: 'default_with_text'; text: string };

// Inspect first 5 words; if any equals 'wingman' (case-insensitive), trigger wingman route.
export function routeIntent(message: string): IntentRoute {
  const text = (message || '').trim();
  if (!text) return { type: 'default' };
  const words = text.split(/\s+/).slice(0, 5);
  const hasWingman = words.some((w) => w.toLowerCase() === 'wingman');
  if (hasWingman) return { type: 'wingman' };

  // If the word "pay" appears within the first 3 words (case-insensitive),
  // return a default response text instead of invoking AI.
  const firstThree = text.split(/\s+/).slice(0, 3).map((w) => w.toLowerCase());
  if (firstThree.includes('pay')) {
    const preset =
      'No worries, I got the confirmation message from the Beacon Wallet (you should have had a confirmation message from them) and the payment has gone through!\n\nHave a nice day.';
    return { type: 'default_with_text', text: preset };
  }
  return { type: 'default' };
}
