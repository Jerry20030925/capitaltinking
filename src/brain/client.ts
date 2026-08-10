import { config } from "../config.js";

/** Robustly extract a JSON object from a model response (handles fences / reasoner). */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // strip ```json ... ``` fences or grab the outermost { ... }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate =
      fenced?.[1] ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    return JSON.parse(candidate);
  }
}

export interface ChatConfig {
  baseUrl: string; // OpenAI-compatible base; "/chat/completions" is appended
  apiKey: string;
  model: string;
  temperature?: number; // omitted for models that reject it (e.g. deepseek-reasoner)
  jsonMode?: boolean; // set response_format json_object (not all providers support it)
}

/**
 * One OpenAI-compatible chat completion. Returns the raw assistant content.
 * Both brains (DeepSeek, Qwen) and the Devil's Advocate go through this so they
 * all speak to their model the same way.
 */
export async function callChat(cfg: ChatConfig, system: string, user: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (cfg.temperature !== undefined) body["temperature"] = cfg.temperature;
  if (cfg.jsonMode) body["response_format"] = { type: "json_object" };

  const res = await fetch(cfg.baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${cfg.model} ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content ?? "{}";
}

/** Primary brain — DeepSeek. deepseek-reasoner rejects temperature + json_object. */
export function callDeepSeek(system: string, user: string): Promise<string> {
  const isReasoner = config.deepseek.model.includes("reasoner");
  return callChat(
    {
      baseUrl: config.deepseek.baseUrl,
      apiKey: config.deepseek.apiKey,
      model: config.deepseek.model,
      temperature: isReasoner ? undefined : 0.2,
      jsonMode: !isReasoner,
    },
    system,
    user,
  );
}

/** Second brain — Qwen (a different model = genuine ensemble diversity). */
export function callQwen(system: string, user: string): Promise<string> {
  return callChat(
    {
      baseUrl: config.secondBrain.baseUrl,
      apiKey: config.secondBrain.apiKey,
      model: config.secondBrain.model,
      temperature: 0.2,
      // rely on extractJson rather than forcing response_format (varies by model).
    },
    system,
    user,
  );
}
