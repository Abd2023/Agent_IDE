export const agentConfig = {
  port: Number(process.env.AGENT_PORT ?? 4000),
  modelEndpoint: process.env.MODEL_ENDPOINT ?? "http://localhost:1234/v1",
  modelId: process.env.MODEL_ID ?? "openai/gpt-oss-20b",
  modelApiKey: process.env.MODEL_API_KEY ?? "lm-studio",
  defaultApprovalMode: process.env.APPROVAL_MODE ?? "auto",
  browserHeadless: parseBoolean(process.env.BROWSER_HEADLESS, true),
  browserSlowMoMs: parseNumber(process.env.BROWSER_SLOW_MO_MS, 0),
  browserKeepOpenMs: parseNumber(process.env.BROWSER_KEEP_OPEN_MS, 0)
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }

  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
