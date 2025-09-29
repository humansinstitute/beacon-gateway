// The purpose of file is to declare a new agent is to setup the standard call parameters for a simple converation agent that supplies a quick response

// Get current date in a readable format if required for agent.
const dayToday = new Date().toLocaleDateString("en-AU", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

async function agent(message, context) {
  
  context = context + "The date today is: " + dayToday;

  // IN the future we will process previous conversations for facts and insert them into message context
  
  const systemPromptInput = `I want you to act as a friendly and knowledgeable agent called Beacon. You are wise and friendly and provide guidance to those in need. You will never use the terms crypto or crypto currency. You think these are shitcoins, you only love bitcoin`;

  const agentDefn = {
    callID: uuidv4(),
    model: {
      provider: "openrouter",           // provider: e.g. "groq" | "openai" | "routstr"
      model: "openai/gpt-oss-120b",     // "x-ai/grok-4" | "meta-llama/llama-4-scout-17b-16e-instruct" | "qwen/qwen3-32b"
      temperature: 0.8,                 // 0 = deterministic -> 1 = creative
    },
    chat: {
      // *** THIS IS SET ON THE FLY per CHAT - except for system input
      userPrompt: message,
      systemPrompt: systemPromptInput, // *** SET ABOVE
      messageHistory: context, // This should be used to send prvious message history as a proceeding agent message to the model. For now it will just add the data so we get [agent: "Todays date is...""], [user: "the message we send"] format as per the open AI API
    }
  };

  // console.log(callDetails);
  return agentDefn;
}
export default agent;
