import { api } from "@/lib/api";
import type {
  ForensicsQueryReq,
  ForensicsQueryResult,
  ForensicsChatReq,
  ForensicsChatMessage,
  ForensicsChatResponse,
} from "@/lib/types";

const MAX_SQL_LENGTH = 8000;
const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 4000;
const MAX_CELL_LENGTH = 200;
const MAX_COLUMNS = 50;
const MAX_RESULT_ROWS_FOR_MODEL = 20;

export function validateProjectId(projectId: string): string {
  const trimmed = projectId ? projectId.trim() : "";
  if (!trimmed) {
    throw new Error("Project ID is required");
  }
  return trimmed;
}

export function validateSqlQuery(sql: string): string {
  const trimmed = sql ? sql.trim() : "";
  if (!trimmed) {
    throw new Error("Query cannot be empty");
  }
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new Error(`Query exceeds maximum allowed length of ${MAX_SQL_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Sanitizes and trims a forensics query result for the AI model:
 * - Columns: maximum 50 columns, each column name trimmed to 200 characters.
 * - Rows: only the first 20 rows are sent to the model (from up to 1000 in raw dataset).
 * - Cells: each cell is trimmed to at most 200 characters.
 */
export function sanitizeForensicsResult(
  result?: ForensicsQueryResult | null
): ForensicsQueryResult | null {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
    return null;
  }

  const columns = result.columns
    .slice(0, MAX_COLUMNS)
    .map((c) => String(c).slice(0, MAX_CELL_LENGTH));

  const rows = result.rows.slice(0, MAX_RESULT_ROWS_FOR_MODEL).map((row) => {
    if (!Array.isArray(row)) return [];
    return row.slice(0, MAX_COLUMNS).map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (typeof cell === "string") return cell.slice(0, MAX_CELL_LENGTH);
      if (typeof cell === "number" || typeof cell === "boolean") return cell;
      if (typeof cell === "object") {
        try {
          return JSON.stringify(cell).slice(0, MAX_CELL_LENGTH);
        } catch {
          return String(cell).slice(0, MAX_CELL_LENGTH);
        }
      }
      return String(cell).slice(0, MAX_CELL_LENGTH);
    });
  });

  return { columns, rows };
}

/**
 * Sanitizes a single message item adhering to the API specification:
 * - role: "user" | "assistant"
 * - content: required string, max 4000 characters
 * - sql: optional string, max 8000 characters
 * - result: optional, only included on assistant messages with sanitized rows/columns
 */
export function sanitizeForensicsMessage(msg: ForensicsChatMessage): ForensicsChatMessage {
  const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
  const rawContent = typeof msg.content === "string" ? msg.content : String(msg.content || "");
  const content = rawContent.slice(0, MAX_CONTENT_LENGTH);

  let sql: string | null = null;
  if (msg.sql) {
    sql = String(msg.sql).slice(0, MAX_SQL_LENGTH);
  }

  let result: ForensicsQueryResult | null = null;
  if (msg.result) {
    result = sanitizeForensicsResult(msg.result);
  }

  return {
    role,
    content,
    ...(sql ? { sql } : {}),
    ...(result ? { result } : {}),
  };
}

/**
 * Validates the full messages array before sending to /forensics/chat:
 * - Must hold 1–20 items.
 * - The last item MUST have role: "user", otherwise backend returns 422.
 */
export function validateForensicsMessages(
  messages: ForensicsChatMessage[]
): ForensicsChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Chat request requires at least 1 message (1–20 items allowed).");
  }

  if (messages.length > MAX_MESSAGES) {
    throw new Error(
      `Chat messages count (${messages.length}) exceeds maximum allowed of ${MAX_MESSAGES} items.`
    );
  }

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") {
    throw new Error(
      "The last message in the chat history must have role: 'user'. Otherwise the API returns 422."
    );
  }

  return messages.map(sanitizeForensicsMessage);
}

/**
 * Builds the contextual messages array (up to 20 items) for the next user turn:
 * - Retains up to 19 previous conversation turns.
 * - Appends the new user message as the final item, ensuring role === "user".
 * - Supports sending the last queried result (e.g. 24h summary result) & SQL on the user message.
 */
export function buildForensicsHistoryContext(
  history: ForensicsChatMessage[],
  nextUser: string | ForensicsChatMessage,
  optionalInitialSql?: string,
  optionalResult?: ForensicsQueryResult | null
): ForensicsChatMessage[] {
  let userMsg: ForensicsChatMessage;
  if (typeof nextUser === "string") {
    userMsg = {
      role: "user",
      content: nextUser.slice(0, MAX_CONTENT_LENGTH),
      ...(optionalInitialSql ? { sql: optionalInitialSql.slice(0, MAX_SQL_LENGTH) } : {}),
      ...(optionalResult ? { result: sanitizeForensicsResult(optionalResult) } : {}),
    };
  } else {
    userMsg = sanitizeForensicsMessage({
      ...nextUser,
      role: "user",
    });
  }

  const sanitizedPrev = history.map(sanitizeForensicsMessage);
  const boundedPrev = sanitizedPrev.slice(-19);

  const combined = [...boundedPrev, userMsg];
  return validateForensicsMessages(combined);
}

export interface SqlGeneratorOptions {
  projectId: string;
  tableName?: string;
  columns?: string[];
  preset?: string;
  customFrom?: string;
  customTo?: string;
  severity?: string;
  source?: string;
  limit?: number;
}

export function generateForensicsSql(opts: SqlGeneratorOptions): string {
  const pid = validateProjectId(opts.projectId);
  const table = opts.tableName || "alerts";
  const cols = opts.columns && opts.columns.length > 0 ? opts.columns.join(", ") : "*";
  const whereClauses: string[] = [`project_id = '${pid.replace(/'/g, "''")}'`];

  if (opts.preset === "24h") {
    whereClauses.push("timestamp >= NOW() - INTERVAL '24 HOURS'");
  } else if (opts.preset === "7d") {
    whereClauses.push("timestamp >= NOW() - INTERVAL '7 DAYS'");
  } else if (opts.preset === "30d") {
    whereClauses.push("timestamp >= NOW() - INTERVAL '30 DAYS'");
  } else if (opts.customFrom || opts.customTo) {
    if (opts.customFrom) {
      whereClauses.push(`timestamp >= '${opts.customFrom.replace(/'/g, "''")}'`);
    }
    if (opts.customTo) {
      whereClauses.push(`timestamp <= '${opts.customTo.replace(/'/g, "''")}'`);
    }
  }

  if (opts.severity && opts.severity !== "ALL") {
    whereClauses.push(`(severity = '${opts.severity.replace(/'/g, "''")}' OR level = '${opts.severity.replace(/'/g, "''")}')`);
  }

  if (opts.source && opts.source !== "ALL") {
    whereClauses.push(`source = '${opts.source.replace(/'/g, "''")}'`);
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);

  return `SELECT ${cols}\nFROM ${table}\nWHERE ${whereClauses.join(
    "\n  AND "
  )}\nLIMIT ${limit};`;
}

export const forensicsService = {
  /**
   * POST /api/v1/projects/{project_id}/forensics/query
   * Executes a forensics SQL query for the specified project.
   */
  query: async (projectId: string, payload: ForensicsQueryReq): Promise<ForensicsQueryResult> => {
    const validId = validateProjectId(projectId);
    const validSql = validateSqlQuery(payload.sql);
    return api.post<ForensicsQueryResult>(
      `/api/v1/projects/${encodeURIComponent(validId)}/forensics/query`,
      { sql: validSql }
    );
  },

  /**
   * POST /api/v1/projects/{project_id}/forensics/chat
   * Sends 1–20 contextual messages to Forensics AI Chat endpoint.
   * Last message must have role: "user".
   */
  chat: async (projectId: string, payload: ForensicsChatReq): Promise<ForensicsChatResponse> => {
    const validId = validateProjectId(projectId);
    const sanitizedMessages = validateForensicsMessages(payload.messages);

    return api.post<ForensicsChatResponse>(
      `/api/v1/projects/${encodeURIComponent(validId)}/forensics/chat`,
      { messages: sanitizedMessages }
    );
  },
};

export interface ForensicsPipelineInput {
  projectId: string;
  userPrompt: string;
  sql?: string;
  fallbackSql?: string;
  filterRange?: string;
  lastQueryResult?: ForensicsQueryResult | null;
  lastQuerySql?: string | null;
  history?: ForensicsChatMessage[];
}

export interface ForensicsPipelineOutput {
  chatResponse: ForensicsChatResponse;
  chatText: string;
  generatedSql: string;
  queryResult: ForensicsQueryResult;
  baselineQueryResult?: ForensicsQueryResult | null;
  updatedHistory: ForensicsChatMessage[];
}

function extractFromParsedObject(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const parts: string[] = [];
  if (typeof o.summary === "string" && o.summary.trim()) {
    parts.push(`**Summary:** ${o.summary.trim()}`);
  }
  if (typeof o.analysis === "string" && o.analysis.trim()) {
    parts.push(`**Analysis:** ${o.analysis.trim()}`);
  }
  if (typeof o.explanation === "string" && o.explanation.trim()) {
    parts.push(o.explanation.trim());
  }
  if (typeof o.findings === "string" && o.findings.trim()) {
    parts.push(`**Findings:** ${o.findings.trim()}`);
  }
  if (parts.length > 0) {
    return parts.join("\n\n");
  }

  // Single string fields
  for (const key of ["reply", "response", "answer", "message", "text", "description", "content"]) {
    if (typeof o[key] === "string" && (o[key] as string).trim()) {
      return (o[key] as string).trim();
    }
  }

  return null;
}

export function extractChatResponseText(res: ForensicsChatResponse | unknown): string {
  if (!res) return "";

  // 1. If it's a string, check if it's wrapped in JSON or markdown JSON block
  if (typeof res === "string") {
    const trimmed = res.trim();
    if (!trimmed) return "";

    // Check for markdown code block containing JSON: ```json { ... } ```
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
    if (jsonBlockMatch && jsonBlockMatch[1]) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        const extracted = extractFromParsedObject(parsed);
        if (extracted) {
          const outsideText = trimmed.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, "").trim();
          return outsideText ? `${outsideText}\n\n${extracted}` : extracted;
        }
      } catch {
        // ignore JSON parse error
      }
    }

    // Check if the entire string is a raw JSON object
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        const extracted = extractFromParsedObject(parsed);
        if (extracted) return extracted;
      } catch {
        // ignore JSON parse error
      }
    }

    return res;
  }

  // 2. If it's an object, check standard fields
  if (typeof res === "object") {
    const r = res as Record<string, unknown>;

    // Handle nested choices (OpenAI style)
    if (Array.isArray(r.choices) && r.choices[0]) {
      return extractChatResponseText(r.choices[0]);
    }

    // Handle nested message object
    if (r.message && typeof r.message === "object") {
      return extractChatResponseText(r.message);
    }

    // Check primary textual properties
    const directText =
      (typeof r.analysis === "string" && r.analysis.trim()) ||
      (typeof r.summary === "string" && r.summary.trim()) ||
      (typeof r.explanation === "string" && r.explanation.trim()) ||
      (typeof r.reply === "string" && r.reply.trim()) ||
      (typeof r.answer === "string" && r.answer.trim()) ||
      (typeof r.response === "string" && r.response.trim()) ||
      (typeof r.message === "string" && r.message.trim()) ||
      (typeof r.text === "string" && r.text.trim()) ||
      (typeof r.content === "string" && r.content.trim());

    if (directText) {
      return extractChatResponseText(directText);
    }

    if (typeof r.detail === "string" && r.detail.trim()) {
      return r.detail.trim();
    }

    // Check any other string properties that aren't metadata/sql
    for (const [key, val] of Object.entries(r)) {
      if (
        typeof val === "string" &&
        val.trim() &&
        !["role", "sql", "query", "generated_sql", "id", "status"].includes(key.toLowerCase())
      ) {
        return extractChatResponseText(val);
      }
    }

    // If only SQL was returned with no human text
    if (r.sql || r.query || r.generated_sql) {
      return "Forensics AI Chat formulated the following query to investigate project security evidence:";
    }

    return "Forensics analysis completed.";
  }

  return String(res);
}

/**
 * Extracts a generated SQL query from the Forensics AI Chat response.
 * Inspects structured fields (sql, query, generated_sql), markdown ```sql code blocks,
 * or raw SELECT statements, falling back to a provided base query if necessary.
 */
export function extractSqlQueryFromChat(
  res: ForensicsChatResponse | unknown,
  fallbackSql?: string
): string {
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    if (typeof r.sql === "string" && r.sql.trim()) return r.sql.trim();
    if (typeof r.query === "string" && r.query.trim()) return r.query.trim();
    if (typeof r.generated_sql === "string" && r.generated_sql.trim()) return r.generated_sql.trim();

    // Check if r.message is an object with sql
    if (r.message && typeof r.message === "object") {
      const m = r.message as Record<string, unknown>;
      if (typeof m.sql === "string" && m.sql.trim()) return m.sql.trim();
      if (typeof m.query === "string" && m.query.trim()) return m.query.trim();
    }

    // Check if r.content has embedded JSON with sql
    if (typeof r.content === "string") {
      const jsonMatch = r.content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed?.sql === "string" && parsed.sql.trim()) return parsed.sql.trim();
          if (typeof parsed?.query === "string" && parsed.query.trim()) return parsed.query.trim();
          if (typeof parsed?.generated_sql === "string" && parsed.generated_sql.trim()) return parsed.generated_sql.trim();
        } catch {
          // not valid json
        }
      }
    }
  }

  if (typeof res === "string") {
    const jsonMatch = res.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed?.sql === "string" && parsed.sql.trim()) return parsed.sql.trim();
        if (typeof parsed?.query === "string" && parsed.query.trim()) return parsed.query.trim();
        if (typeof parsed?.generated_sql === "string" && parsed.generated_sql.trim()) return parsed.generated_sql.trim();
      } catch {
        // not valid json
      }
    }
  }

  const text = typeof res === "string" ? res : (typeof res === "object" && res && "content" in res && typeof (res as Record<string, unknown>).content === "string" ? (res as Record<string, unknown>).content as string : extractChatResponseText(res));
  if (text) {
    // 1. Look for ```sql ... ``` block
    const codeBlockMatch = text.match(/```(?:sql|psql|postgresql)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch && codeBlockMatch[1] && codeBlockMatch[1].trim()) {
      const candidate = codeBlockMatch[1].trim();
      if (/^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(candidate)) {
        return candidate;
      }
    }

    // 2. Look for raw SELECT ... statement
    const rawMatch = text.match(/\b(SELECT\s+[\s\S]+?(?:;|$))/i);
    if (rawMatch && rawMatch[1] && rawMatch[1].trim()) {
      return rawMatch[1].trim();
    }
  }

  if (fallbackSql && fallbackSql.trim()) {
    return fallbackSql.trim();
  }

  throw new Error("Forensics AI Chat did not generate a valid SQL query.");
}

/**
 * Executes the project forensics pipeline:
 * Step 1: Send user inquiry to Forensics AI Chat (attaching last query SQL & result if available).
 * Step 2: Extract the generated SQL query from the chat response.
 * Step 3: Give that generated query to the Forensics Query API to generate summary.
 * Step 4: Store and return updated conversation history with drafted SQL & sanitized query results.
 */
export async function executeForensicsPipeline(
  input: ForensicsPipelineInput,
  client: {
    query: (projectId: string, payload: ForensicsQueryReq) => Promise<ForensicsQueryResult>;
    chat: (projectId: string, payload: ForensicsChatReq) => Promise<ForensicsChatResponse>;
  } = forensicsService
): Promise<ForensicsPipelineOutput> {
  const { projectId, userPrompt, sql, fallbackSql, filterRange, history = [] } = input;
  validateProjectId(projectId);
  const baseFallback = input.lastQuerySql || fallbackSql || sql;
  const baseResult = input.lastQueryResult;

  // Step 1: Call Forensics AI Chat with user message carrying last queried result & sql (if any)
  const contextualPrompt = filterRange
    ? `${userPrompt}\n[Time Filter Range: ${filterRange}]`
    : userPrompt;

  const userMsgToSend: ForensicsChatMessage = {
    role: "user",
    content: contextualPrompt.slice(0, MAX_CONTENT_LENGTH),
    ...(baseFallback ? { sql: baseFallback.slice(0, MAX_SQL_LENGTH) } : {}),
    ...(baseResult ? { result: sanitizeForensicsResult(baseResult) } : {}),
  };

  const messagesToSend = buildForensicsHistoryContext(history, userMsgToSend);

  const chatResponse = await client.chat(projectId, { messages: messagesToSend });
  const chatText = extractChatResponseText(chatResponse);

  // Step 2: Extract the generated SQL query from Chat response
  const rawGeneratedSql = extractSqlQueryFromChat(chatResponse, baseFallback);
  const generatedSql = validateSqlQuery(rawGeneratedSql);

  // Step 3: Give that generated query to the Forensics Query API to generate summary
  const queryResult = await client.query(projectId, { sql: generatedSql });

  // Step 4: Construct updated history (capped to 20 items) with drafted SQL & sanitized result on assistant message
  const userItem: ForensicsChatMessage = {
    role: "user",
    content: contextualPrompt.slice(0, MAX_CONTENT_LENGTH),
    ...(baseFallback ? { sql: baseFallback.slice(0, MAX_SQL_LENGTH) } : {}),
    ...(baseResult ? { result: sanitizeForensicsResult(baseResult) } : {}),
  };

  const assistantItem: ForensicsChatMessage = {
    role: "assistant",
    content: (chatText || "Query generated and executed.").slice(0, MAX_CONTENT_LENGTH),
    sql: generatedSql.slice(0, MAX_SQL_LENGTH),
    result: sanitizeForensicsResult(queryResult),
  };

  const updatedHistory = [...history, userItem, assistantItem].slice(-MAX_MESSAGES);

  return {
    chatResponse,
    chatText,
    generatedSql,
    queryResult,
    baselineQueryResult: baseResult,
    updatedHistory,
  };
}
