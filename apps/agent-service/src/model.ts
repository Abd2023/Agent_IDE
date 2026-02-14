import { agentConfig } from "./config.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export async function callModel(messages: ChatMessage[]): Promise<string> {
  const endpoint = `${agentConfig.modelEndpoint.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agentConfig.modelApiKey}`
    },
    body: JSON.stringify({
      model: agentConfig.modelId,
      temperature: 0.2,
      messages
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`model request failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("model response was empty");
  }

  return content.trim();
}

export async function generateChatReply(message: string, workspaceRoot?: string): Promise<string> {
  const location = workspaceRoot ? `Workspace root: ${workspaceRoot}` : "Workspace root not provided.";
  const content = await callModel([
    {
      role: "system",
      content:
        "You are a local coding agent assistant. Reply in 2-4 short sentences with practical guidance and no markdown."
    },
    {
      role: "user",
      content: `${location}\nUser task: ${message}`
    }
  ]);

  return content;
}

