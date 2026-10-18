// One assistant turn: stream the model's answer, run any get_logs tool calls the model asks for
// (clamped to the servers fixed at session creation, INV-AI-2), and loop a bounded number of rounds.

import { buildContext } from "./context.ts";
import { collectData } from "./collect.ts";
import { AiProviderError } from "./errors.ts";
import { GET_LOGS_TOOL, SYSTEM_PROMPT } from "./prompt.ts";
import { parseRange } from "./schema.ts";
import type { Session } from "./sessions.ts";
import { SOURCES } from "./types.ts";
import type { AiConfig, Backend, Block, DataUsed, LlmEvent, LlmMessage, LlmParams, Source, SseEvent } from "./types.ts";

export const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_CALLS_PER_ROUND = 3;

export interface TurnDeps {
  llm: (p: LlmParams) => AsyncIterable<LlmEvent>;
  backend: Backend;
  config: AiConfig;
  now: () => number;
}

interface ToolOutcome {
  content: string;
  isError: boolean;
  summary: string;
}

const oneLine = (s: unknown, n = 60) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const err = (content: string): ToolOutcome => ({ content, isError: true, summary: content });

function mergeDataUsed(session: Session, add: DataUsed, notes: string[]) {
  const cur = session.dataUsed;
  if (!cur) {
    session.dataUsed = add;
  } else {
    cur.record_count += add.record_count;
    for (const s of add.sources) {
      const hit = cur.sources.find((x) => x.source === s.source);
      if (hit) hit.count += s.count;
      else cur.sources.push({ ...s });
    }
    if (Date.parse(add.range.from) < Date.parse(cur.range.from)) cur.range.from = add.range.from;
    if (Date.parse(add.range.to) > Date.parse(cur.range.to)) cur.range.to = add.range.to;
    cur.truncated = cur.truncated || add.truncated;
    for (const u of add.unavailable) if (!cur.unavailable.includes(u)) cur.unavailable.push(u);
  }
  for (const n of notes) if (!session.truncation.includes(n)) session.truncation.push(n);
}

async function executeGetLogs(deps: TurnDeps, session: Session, input: Record<string, unknown>): Promise<ToolOutcome> {
  const source = input.source;
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
    return err("Invalid source. Use one of: decoy_events, tamper_history, forensic_findings, system_logs.");
  }
  if (typeof input.server !== "string" || !input.server.trim()) return err("Missing server.");
  const range = parseRange({ from: input.from, to: input.to }, deps.now());
  if (!range) return err("Invalid time range: use ISO-8601 timestamps with timezone, from before to, at most 30 days apart, not in the future.");

  const wanted = input.server.trim().toLowerCase();
  const server = session.scope.servers.find((s) => s.id.toLowerCase() === wanted || s.hostname.toLowerCase() === wanted);
  if (!server) return err(`Server "${oneLine(input.server)}" is not part of this session's selected scope. Available: ${session.scope.servers.map((s) => s.hostname).join(", ")}.`);

  const got = await collectData({ backend: deps.backend, servers: [server], range, sources: [source as Source], filters: session.scope.filters });
  if (got.unavailable.length) return err(`The ${source} source is currently unavailable (${got.unavailable[0].reason}).`);

  const built = buildContext({
    records: got.records,
    servers: [server],
    range,
    sources: [source as Source],
    unavailable: [],
    notes: got.notes,
    tokenBudget: Math.min(6000, Math.floor(deps.config.tokenBudget / 2)),
  });
  mergeDataUsed(session, built.dataUsed, built.truncation);
  return { content: built.text, isError: false, summary: `${built.dataUsed.record_count} ${source} record(s) from ${server.hostname}` };
}

export async function* runTurn(
  deps: TurnDeps,
  input: { session: Session; userMessage: LlmMessage; signal?: AbortSignal },
  out: { text: string }
): AsyncGenerator<SseEvent> {
  const { session } = input;
  const working: LlmMessage[] = [...session.messages, input.userMessage];
  let fullText = "";
  let stop = "end_turn";

  for (let round = 0; ; round++) {
    const tools = round < MAX_TOOL_ROUNDS ? [GET_LOGS_TOOL] : [];
    const uses: Extract<LlmEvent, { type: "tool_use" }>[] = [];
    let roundText = "";

    for await (const ev of deps.llm({ config: deps.config, system: SYSTEM_PROMPT, messages: working, tools, signal: input.signal })) {
      if (ev.type === "text") {
        roundText += ev.text;
        fullText += ev.text;
        yield { type: "delta", text: ev.text };
      } else if (ev.type === "tool_use") {
        uses.push(ev);
      } else {
        stop = ev.reason;
      }
    }

    if (uses.length === 0 || tools.length === 0) break;

    const calls = uses.slice(0, MAX_TOOL_CALLS_PER_ROUND);
    const assistantBlocks: Block[] = [
      ...(roundText ? [{ type: "text", text: roundText } as Block] : []),
      ...calls.map((u) => ({ type: "tool_use", id: u.id, name: u.name, input: u.input, ...(u.signature ? { signature: u.signature } : {}) }) as Block),
    ];
    const results: Block[] = [];

    for (const u of calls) {
      yield { type: "tool", name: u.name, status: "running", summary: `${oneLine(u.input.server)} / ${oneLine(u.input.source)}` };
      let outcome: ToolOutcome;
      if (u.name !== "get_logs") {
        outcome = err("Unknown tool.");
      } else {
        try {
          outcome = await executeGetLogs(deps, session, u.input);
        } catch {
          outcome = err("The data source could not be read right now.");
        }
      }
      yield { type: "tool", name: u.name, status: outcome.isError ? "error" : "done", summary: oneLine(outcome.summary, 160) };
      if (!outcome.isError && session.dataUsed) {
        yield { type: "data_used", data_used: session.dataUsed, truncation: session.truncation };
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
    }

    working.push({ role: "assistant", content: assistantBlocks }, { role: "user", content: results });
  }

  if (!fullText.trim()) throw new AiProviderError("provider_bad_response");
  out.text = fullText;
  yield { type: "done", stop_reason: stop };
}
