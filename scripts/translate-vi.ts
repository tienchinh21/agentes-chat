/**
 * One-time script to translate `i18n-work/vi.todo.json` into `i18n-work/vi.done.json`.
 * Supports Gemini API (`GEMINI_API_KEY`) or any OpenAI-compatible API (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL`).
 *
 * Usage:
 *   GEMINI_API_KEY=... bun scripts/translate-vi.ts
 *   # or:
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_MODEL=google/gemini-2.5-flash bun scripts/translate-vi.ts
 *
 * Then apply to the app:
 *   bun run i18n:apply vi i18n-work/vi.done.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Forms = string | Record<string, string>;

interface TodoItem {
  file: string;
  key: string;
  en: Forms;
  note?: string;
  vars?: string[];
  tags?: string[];
}

interface DoneItem {
  file: string;
  key: string;
  value: Forms;
}

const ROOT = join(import.meta.dir, "..");
const TODO_PATH = join(ROOT, "i18n-work", "vi.todo.json");
const DONE_PATH = join(ROOT, "i18n-work", "vi.done.json");

const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
  console.error("Missing API key. Set GEMINI_API_KEY or OPENAI_API_KEY (with optional OPENAI_BASE_URL and OPENAI_MODEL).");
  process.exit(1);
}

const todoData = JSON.parse(readFileSync(TODO_PATH, "utf8")) as { items: TodoItem[] };
const existingDone: DoneItem[] = existsSync(DONE_PATH)
  ? (JSON.parse(readFileSync(DONE_PATH, "utf8")) as { items: DoneItem[] }).items
  : [];

const doneMap = new Map<string, DoneItem>(existingDone.map((item) => [`${item.file}:${item.key}`, item]));
const pending = todoData.items.filter((item) => !doneMap.has(`${item.file}:${item.key}`));

console.log(`Total: ${todoData.items.length} | Already done: ${doneMap.size} | Remaining: ${pending.length}`);
if (pending.length === 0) {
  console.log("Nothing left to translate. Run: bun run i18n:apply vi i18n-work/vi.done.json");
  process.exit(0);
}

function buildPrompt(batch: TodoItem[]): string {
  const payload = batch.map((item) => ({
    key: item.key,
    en: typeof item.en === "string" ? item.en : (item.en.other ?? Object.values(item.en)[0] ?? ""),
    ...(item.note ? { note: item.note } : {}),
    ...(item.vars?.length ? { vars: item.vars } : {}),
  }));

  return [
    "Translate the following UI strings for a team & AI-agent chat platform (like Slack) from English to natural, concise Vietnamese.",
    "Rules:",
    "1. Return ONLY a valid JSON object mapping each `key` to its Vietnamese string translation.",
    "2. Keep ALL {{placeholders}}, HTML/XML tags (<0>...</0>, <1/>), markdown, and product/brand names (agentes.chat, Slack, GitHub, Claude, Codex, MCP, Tailscale, etc.) intact.",
    "3. Use natural Vietnamese UI phrasing (e.g. channel -> kênh, workspace -> không gian làm việc or workspace, agent -> agent).",
    "",
    JSON.stringify(payload),
  ].join("\n");
}

async function callLLM(prompt: string): Promise<Record<string, string>> {
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    return JSON.parse(text) as Record<string, string>;
  }

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise software UI translator. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text) as Record<string, string>;
}

async function translateBatch(batch: TodoItem[], attempt = 1): Promise<DoneItem[]> {
  try {
    const translated = await callLLM(buildPrompt(batch));
    const results: DoneItem[] = [];
    for (const item of batch) {
      const viText = translated[item.key];
      if (typeof viText !== "string" || !viText.trim()) continue;
      results.push({
        file: item.file,
        key: item.key,
        value: typeof item.en === "string" ? viText : { other: viText },
      });
    }
    return results;
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return translateBatch(batch, attempt + 1);
    }
    console.error(`Batch failed after 3 attempts:`, err);
    return [];
  }
}

function saveProgress() {
  writeFileSync(DONE_PATH, JSON.stringify({ items: [...doneMap.values()] }, null, 2));
}

const batches: TodoItem[][] = [];
for (let i = 0; i < pending.length; i += BATCH_SIZE) {
  batches.push(pending.slice(i, i + BATCH_SIZE));
}

let completedBatches = 0;
let cursor = 0;

async function worker() {
  while (cursor < batches.length) {
    const idx = cursor++;
    const batch = batches[idx]!;
    const translated = await translateBatch(batch);
    for (const item of translated) {
      doneMap.set(`${item.file}:${item.key}`, item);
    }
    completedBatches++;
    saveProgress();
    console.log(`[${completedBatches}/${batches.length}] Translated ${doneMap.size}/${todoData.items.length} keys`);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
saveProgress();
console.log(`\nDone! Saved to ${DONE_PATH}. Next run:\n  bun run i18n:apply vi i18n-work/vi.done.json`);
