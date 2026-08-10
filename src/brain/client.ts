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

/**
 * One DeepSeek chat completion. Returns the raw assistant message content.
 * Shared by every "agent" (Chief Trader, Devil's Advocate, …) so they all
 * speak to the model the same way. deepseek-reasoner ignores temperature and
 * rejects json_object response_format, so we only set those for deepseek-chat.
 */
export async function callDeepSeek(system: string, user: string): Promise<string> {
  const isReasoner = config.deepseek.model.includes("reasoner");
  const body: Record<string, unknown> = {
    model: config.deepseek.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (!isReasoner) {
    body["temperature"] = 0.2;
    body["response_format"] = { type: "json_object" };
  }

  const res = await fetch(config.deepseek.baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deepseek.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content ?? "{}";
}
