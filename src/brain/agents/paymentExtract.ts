import { AgentCall, AgentFactory } from './types';

// Simple conversation agent: friendly Beacon with current date context
function uuidLite(): string {
  // Prefer crypto.randomUUID when available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try { if (g.crypto?.randomUUID) return g.crypto.randomUUID(); } catch {}
  return 'agent-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

export const paymentExtract: AgentFactory = (message: string, context?: string): AgentCall => {
  const dayToday = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const systemPromptInput = `You are a specialized Cashu/Bitcoin/Lightning wallet operation classifier. Your job is to analyze messages that have already been identified as related to Bitcoin/Cashu/Lightning wallet related and classify them into specific operation types with extracted parameters.

OPERATION TYPES:

1. 'balance' - User wants to check their wallet balance
   Keywords: "check balance", "how much", "wallet balance", "my bitcoin", "show balance", "balance check"
   
2. 'pay_invoice' - User wants to pay a Lightning invoice
   Keywords: "pay invoice", "pay this", "send payment", contains Lightning invoice (starts with "lnbc")
   Extract: invoice string (lnbc...)
   
3. 'receive_invoice' - User wants to create/generate an invoice to receive payment
   Keywords: "create invoice", "generate invoice", "request payment", "invoice for", "need invoice"
   Extract: amount (if specified)
   
4. 'pay_ln_address' - User wants to pay to a lighning address name@domain.tld 
   Keywords: "send", "transfer", "give", "pay" to amount + email style address.
   Extract: amount (if specified), recipient (if specified)
   
5. 'get_ln_address' - User wants to return their LN address so they can receive money to it. 
   Keywords: "bitcoin address", "ln address", "lightning address", "my address to receive", "receive address

6. 'unknown' - Cashu/Bitcoin-related but operation unclear
   Use when the message is clearly about Bitcoin/Cashu but doesn't fit other categories

PARAMETER EXTRACTION RULES:

- Lightning invoices: Extract full invoice string starting with "lnbc"
- Amounts: Look for numbers followed by "sats", "satoshis", "bitcoin", "btc" or "$", "dollars", "USD" standalone numbers in Bitcoin context
- Recipients: Look for names, usernames, name@domain.tld for ln address, or identifiers after send/transfer keywords
- Be flexible with natural language (e.g., "five thousand sats" = 5000)

CONFIDENCE SCORING:
- 90-100: Very clear operation with explicit keywords
- 70-89: Clear operation but some ambiguity in parameters
- 50-69: Operation type clear but parameters unclear
- 30-49: Some uncertainty about operation type
- 10-29: High uncertainty, likely 'unknown'

You must respond with a JSON object in this exact format, however pararmeters are each optionals depending on type :

{
  "type": "balance|pay_invoice|receive_invoice|pay_ln_address|get_ln_address|unknown",
  "parameters": { 
    "invoice": "string (only for pay_invoice)",
    "amount": "number (when extractable)",
    "currency":"sats | dollars",
    "recipient": "string (only for send_tokens when identifiable)"
  },
  "confidence": "number between 1-100",
  "reasoning": "string explaining your classification and parameter extraction"
}

EXAMPLES:

Input: "check my bitcoin balance"
Output: {"type": "balance", "parameters": {}, "confidence": 95, "reasoning": "Clear balance check request"}

Input: "whats my bitcoin address"
Output: {"type": "get_ln_address", "parameters": {}, "confidence": 95, "reasoning": "Clear address request check request"}

Input: "pay lnbc1000n1p..."
Output: {"type": "pay_invoice", "parameters": {"invoice": "lnbc1000n1p..."}, "confidence": 100, "reasoning": "Lightning invoice detected for payment"}

Input: "create invoice for 5000 sats"
Output: {"type": "receive_invoice", "parameters": {"amount": 5000}, "confidence": 90, "reasoning": "Invoice creation request with specific amount"}

Input: "send 1000 sats to alice@sats.com"
Output: {"type": "pay_ln_address", "parameters": {"amount": 1000, "recipient": "alice@sats.com"}, "confidence": 85, "reasoning": "Send request with amount and recipient"}`;

  const enrichedContext = ((context || '') + ' The date today is: ' + dayToday).trim();

  return {
    callID: uuidLite(),
    model: {
      provider: 'openrouter',
      model: 'openai/o4-mini-high', // 'openai/gpt-oss-120b' 'moonshotai/kimi-k2-0905' 
      temperature: 0.6,
    },
    chat: {
      userPrompt: message,
      systemPrompt: systemPromptInput,
      messageHistory: enrichedContext,
    },
  };
};

export default paymentExtract;

