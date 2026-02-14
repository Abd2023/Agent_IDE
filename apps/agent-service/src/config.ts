export const agentConfig = {
  port: Number(process.env.AGENT_PORT ?? 4000),
  modelEndpoint: process.env.MODEL_ENDPOINT ?? "http://localhost:1234/v1",
  modelId: process.env.MODEL_ID ?? "openai/gpt-oss-20b",
  modelApiKey: process.env.MODEL_API_KEY ?? "lm-studio",
  defaultApprovalMode: process.env.APPROVAL_MODE ?? "auto"
};
