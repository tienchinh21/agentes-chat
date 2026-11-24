import {
  foldText,
  normalizeUrl,
  type OutboundCode,
  outboundUrlProblem,
  urlCopiesPrivateText,
  urlsIn,
} from "@agenteschat/adapters";
import { and, desc, eq, gt, inArray, isNull, not, or, schema, sql } from "@agenteschat/db";
import type { ToolContext, ToolOutput } from "./tools/types";
import { IMAGE_SEARCH_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./web-tools";

const THREAD_LIMIT = 500;
const CHANNEL_LIMIT = 50;
const CACHED_RUNS = 200;
/**
 * Characters of tool output the cache holds at most, across runs: a run's whole outputs are kept, and 200 runs reading
 * large files or pages each held them for the life of the process. Past it the least recently used runs go; their
 * next check reads their stored steps again, as an evicted run's always did.
 */
export const CACHED_CHARS = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RunReads {
  seq: number;
  seen: Set<string>;
  privateText: string[];
  /** What the agent itself wrote to its browser: where it can make a page or a tool's answer show any address. */
  written: string[];
  names: Map<string, string>;
  /** Null: a call outside a stored run, never cached. */
  runId: string | null;
  /** Characters held in `privateText` and `written`. */
  chars: number;
}

/** Per run, what its steps added so far: each check reads only the steps since the last one. Least recently used first. */
const cache = new Map<string, RunReads>();
let cachedChars = 0;

const evict = (runId: string) => {
  cachedChars -= cache.get(runId)?.chars ?? 0;
  cache.delete(runId);
};

/** Characters `addResult` and `addWritten` just added to a cached run: past `CACHED_CHARS`, the oldest runs go. */
function grew(reads: RunReads, chars: number) {
  reads.chars += chars;
  // Evicted meanwhile (or never cached): it holds nothing the cache counts.
  if (!reads.runId || cache.get(reads.runId) !== reads) return;
  cachedChars += chars;
  for (const oldest of cache.keys()) {
    if (cachedChars <= CACHED_CHARS) break;
    evict(oldest);
  }
}

/** Tests: the runs the cache holds, least recently used first, and their characters. */
export const outboundCached = () => ({ runs: [...cache.keys()], chars: cachedChars });

/**
 * `outboundUrlProblem` with what this run knows (ADR 0117): `seen` is every address in the conversation (the
 * thread, the channel's latest messages) and in this run's tool results; `privateText` every tool result of the
 * run except the public web's. Null: the agent may open it.
 */
export async function checkOutboundUrl(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
  url: string,
): Promise<{ code: OutboundCode; message: string } | null> {
  const reads = await runReads(ctx);
  const seen = reads.seen;
  // The cheap checks first: a plain address needs no conversation.
  if (!outboundUrlProblem(url, { privateText: reads.privateText })) return null;
  for (const u of await conversationUrls(ctx)) seen.add(u);
  return outboundUrlProblem(url, { seen: (u) => seen.has(u), privateText: reads.privateText });
}

/** `checkOutboundUrl` as a tool's refusal (its code in `data.code`, final for the continuation), null to go on. */
export async function outboundRefusal(
  ctx: Parameters<typeof checkOutboundUrl>[0],
  url: string,
): Promise<ToolOutput | null> {
  const problem = await checkOutboundUrl(ctx, url);
  return problem ? { content: problem.message, isError: true, data: { code: problem.code, url } } : null;
}

const emptyReads = (runId: string | null = null): RunReads => ({
  runId,
  seq: -1,
  seen: new Set(),
  privateText: [],
  written: [],
  names: new Map(),
  chars: 0,
});

function cachedReads(runId: string): RunReads {
  let reads = cache.get(runId);
  if (reads) {
    // Used again: the newest, the last to go.
    cache.delete(runId);
    cache.set(runId, reads);
    return reads;
  }
  reads = emptyReads(runId);
  if (cache.size >= CACHED_RUNS) evict(cache.keys().next().value as string);
  cache.set(runId, reads);
  return reads;
}

/**
 * Where the run's browser is, as the browser says it in a browser tool's result; a refusal's `data.url` is only what
 * was asked. Nothing the agent wrote gets here: it reaches an address by `outboundRefusal` or by the page's own doing.
 */
function browserPage(tool: string, data: unknown): string | null {
  const d = data as { url?: unknown; code?: unknown } | null | undefined;
  if (!tool.startsWith("browser_") || typeof d?.url !== "string" || d.code !== undefined) return null;
  return normalizeUrl(d.url);
}

/**
 * One tool result into what the run read. A private result's address that copies text the run read before is no
 * seen address: the agent made it (printed by run_code, echoed by any tool), so it gets the full check. The page the
 * browser is on is the exception, with the addresses that page shows on its own site: that server already has what
 * they carry, so going back sends nothing new. Unless the agent wrote that text to the browser itself: a tool's answer
 * repeats what it was asked (`find`, a target) beside the page, and a field shows what was typed in it, and neither
 * came from the server.
 */
function addResult(reads: RunReads, tool: string, content: string, data?: unknown) {
  const web = tool === WEB_SEARCH_TOOL || tool === WEB_FETCH_TOOL || tool === IMAGE_SEARCH_TOOL;
  const page = browserPage(tool, data);
  if (page) reads.seen.add(page);
  const site = page && new URL(page).host;
  for (const u of urlsIn(content)) {
    const own = site !== null && new URL(u).host === site && !urlCopiesPrivateText(u, reads.written);
    if (web || own || reads.seen.has(u) || !urlCopiesPrivateText(u, reads.privateText)) reads.seen.add(u);
  }
  // The public web's results are no private text.
  if (web) return;
  const folded = foldText(content);
  reads.privateText.push(folded);
  grew(reads, folded.length);
}

const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(stringsIn)
      : [];

/** A browser tool's input as `written`: its text, and what its addresses carry decoded, as an address is compared. */
function addWritten(reads: RunReads, tool: string, input: unknown) {
  if (!tool.startsWith("browser_")) return;
  for (const text of stringsIn(input)) {
    const added = [text, ...urlsIn(text).map((u) => [...new URL(u).searchParams.values()].join(" "))];
    reads.written.push(...added);
    grew(
      reads,
      added.reduce((n, a) => n + a.length, 0),
    );
  }
}

/**
 * A tool's whole output, as the model got it: run steps keep only its first 4000 characters, and the check must
 * see all of it. Called by the gateway for each result of a stored run, with the call's input.
 */
export function recordRead(runId: string, tool: string, content: string, data?: unknown, input?: unknown) {
  if (!UUID.test(runId)) return;
  const reads = cachedReads(runId);
  addWritten(reads, tool, input);
  addResult(reads, tool, content, data);
}

async function runReads(ctx: Pick<ToolContext, "db" | "orgId" | "runId">): Promise<RunReads> {
  // A call outside a stored run (a test's bare context) has no reads.
  if (!UUID.test(ctx.runId)) return emptyReads();
  const reads = cachedReads(ctx.runId);
  const steps = await ctx.db
    .select({ seq: schema.agentRunSteps.seq, kind: schema.agentRunSteps.kind, data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, ctx.orgId),
        eq(schema.agentRunSteps.runId, ctx.runId),
        inArray(schema.agentRunSteps.kind, ["tool_call", "tool_result"]),
        gt(schema.agentRunSteps.seq, reads.seq),
      ),
    )
    .orderBy(schema.agentRunSteps.seq);
  for (const { seq, kind, data } of steps) {
    reads.seq = Math.max(reads.seq, seq);
    const id = typeof data.toolUseId === "string" ? data.toolUseId : "";
    const name = typeof data.name === "string" ? data.name : "";
    if (kind === "tool_call") {
      if (id) reads.names.set(id, name);
      addWritten(reads, name, data.input);
      continue;
    }
    addResult(reads, reads.names.get(id) ?? name, String(data.content ?? ""), data.data);
  }
  return reads;
}

/**
 * Addresses people and agents wrote where this run answers: its thread, and the channel's latest messages. What
 * this agent posted since the run started is left out: an address it posted itself is no seen address.
 */
async function conversationUrls(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "channelId" | "threadRootId" | "triggerMessageId">,
): Promise<string[]> {
  const m = schema.messages;
  const ids = [ctx.threadRootId, ctx.triggerMessageId].filter((id) => UUID.test(id));
  if (!UUID.test(ctx.channelId)) return [];
  const own = UUID.test(ctx.runId)
    ? sql`(${m.authorAgentId} is not distinct from ${ctx.agentId} and ${m.createdAt} >= (select ${schema.agentRuns.createdAt} from ${schema.agentRuns} where ${schema.agentRuns.id} = ${ctx.runId}))`
    : sql`false`;
  const scope = and(eq(m.orgId, ctx.orgId), eq(m.channelId, ctx.channelId), isNull(m.deletedAt), not(own));
  const [thread, recent] = await Promise.all([
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, ids.length > 0 ? or(inArray(m.threadId, ids), inArray(m.id, ids)) : sql`false`))
      .orderBy(desc(m.createdAt))
      .limit(THREAD_LIMIT),
    ctx.db
      .select({ body: m.body })
      .from(m)
      .where(and(scope, isNull(m.threadId)))
      .orderBy(desc(m.createdAt))
      .limit(CHANNEL_LIMIT),
  ]);
  return [...thread, ...recent].flatMap((r) => urlsIn(r.body));
}
