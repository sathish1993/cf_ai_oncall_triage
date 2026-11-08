import type { Env } from "./types";
import { mockChat, mockEmbed, mockJson } from "./mock-ai";

export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// The generated AI types are a union over every model; we only use two, so we
// call through a narrow signature instead of fighting the overloads.
type RunFn = (model: string, input: Record<string, unknown>) => Promise<unknown>;
const run = (env: Env): RunFn => env.AI.run.bind(env.AI) as unknown as RunFn;

export async function chat(env: Env, messages: ChatMessage[], maxTokens = 700): Promise<string> {
  if (env.MOCK_AI === "1") return mockChat(messages);
  const out = (await run(env)(CHAT_MODEL, { messages, max_tokens: maxTokens, temperature: 0.3 })) as {
    response?: string;
  };
  return (out.response ?? "").trim();
}

/**
 * Ask Llama for JSON that matches a schema. Workers AI JSON mode usually hands back an
 * object already; when it returns a string (or the model wraps it in prose) we parse it out.
 */
export async function chatJson<T>(
  env: Env,
  kind: string,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
): Promise<T> {
  if (env.MOCK_AI === "1") return mockJson(kind, messages) as T;
  const out = (await run(env)(CHAT_MODEL, {
    messages,
    max_tokens: 1200,
    temperature: 0.1,
    response_format: { type: "json_schema", json_schema: schema },
  })) as { response?: unknown };
  const r = out.response;
  if (r && typeof r === "object") return r as T;
  return parseJsonLoose<T>(String(r ?? ""));
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`model did not return JSON: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export async function embed(env: Env, text: string): Promise<number[]> {
  if (env.MOCK_AI === "1") return mockEmbed(text);
  const out = (await run(env)(EMBED_MODEL, { text: [text.slice(0, 2000)] })) as { data: number[][] };
  return out.data[0];
}

export async function embedMany(env: Env, texts: string[]): Promise<number[][]> {
  if (env.MOCK_AI === "1") return texts.map(mockEmbed);
  const out = (await run(env)(EMBED_MODEL, { text: texts.map((t) => t.slice(0, 2000)) })) as { data: number[][] };
  return out.data;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
