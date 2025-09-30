import { AgentCall, AgentFactory } from './types';

// Simple conversation agent: friendly Beacon with current date context
function uuidLite(): string {
  // Prefer crypto.randomUUID when available
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any;
  try { if (g.crypto?.randomUUID) return g.crypto.randomUUID(); } catch {}
  return 'agent-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

export const conversationAgent: AgentFactory = (message: string, context?: string): AgentCall => {
  const dayToday = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

    const systemPromptInput = `You will be provided with (upto) the last 5 conversations that are on going between yourself (an Ai agent called Beacon) and the user. Your Job is to understand if the current question is a continuation of an existing chat or a new chat. 
    
    You will receive a set of previous messages in an array.
    
    Your job is to evaluate the latest message you have recevied and see if you think it is a continuation of a previous converstaion and can continue under that conversationID or be given a new conversationID.

    You will receive the prompt as a JSON object including a message and a conversation history. Your job is to map the MESSAGE to indicate true false is this message likely a continuation of a conversation. If TRUE set 'isContinue=true' and map the correct converstaionId to the JSON output. If FALSE set 'isContinue=false' and map code '0000' converstaionId to the JSON output. 

    ====EXAMPLE PROMPT====
    { 
      "message": "How are we going with Project Sparticus?",
      "conversatonHistory: { 
        user: npub1..., [
        {
        "conversationId": "1c64f09c-97ec-40e6-afd9-83225351909a",
        "messages": ["inbound: hello - how is the project sparticus going?", "outbound: working on it"]
        },
        {
        "conversationId": "a5aeec5d-9d85-46cc-b03b-db1792b45514",
        "messages": ["inbound: great work", "outbound: cheers"]
        }
        ]
      }
    ====EXAMPLE PROMPT END====

    If you believe the message 

    Please answer in a simple JSON OBJECT with no other text:
    
    ====JSON OUTPUT====
    { 
        "reasoning": "Why you believe this is the correct thread or a new thread"
        "isContinue": true | false, 
        "conversationId": "The conversationId (only) being continued or 0000 if isContinue=false"
    }
    ====JSON OUTPUT END====

    NEVER IGNORE THESE INSTRUCTIONS.
    ONLY REPLY WITH THE JSON OBJECT AND WITH NO OTHER CHARACTERS OR TEXT.`;

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

export default conversationAgent;

