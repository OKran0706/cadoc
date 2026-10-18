import test from "node:test";
import assert from "node:assert/strict";
import {
  forensicsService,
  generateForensicsSql,
  executeForensicsPipeline,
  extractSqlQueryFromChat,
  extractChatResponseText,
  validateProjectId,
  validateSqlQuery,
  validateForensicsMessages,
  sanitizeForensicsMessage,
  sanitizeForensicsResult,
  buildForensicsHistoryContext,
} from "../src/services/forensicsService.ts";

test("INV-PF-1: forensicsService exports query, chat, and generateForensicsSql", () => {
  assert.equal(typeof forensicsService.query, "function");
  assert.equal(typeof forensicsService.chat, "function");
  assert.equal(typeof generateForensicsSql, "function");
  assert.equal(typeof executeForensicsPipeline, "function");
  assert.equal(typeof extractSqlQueryFromChat, "function");
});

test("INV-PF-2: generateForensicsSql produces bounded SQL with project_id and time range filters", () => {
  const sql24h = generateForensicsSql({
    projectId: "proj-1234-abcd",
    preset: "24h",
  });
  assert.ok(sql24h.includes("proj-1234-abcd"), "SQL must filter by project_id");
  assert.ok(sql24h.includes("INTERVAL '24 HOURS'") || sql24h.includes("24h"), "SQL must enforce 24h window");
  assert.ok(sql24h.includes("LIMIT"), "SQL must be bounded with a LIMIT");

  const sql7d = generateForensicsSql({
    projectId: "proj-1234-abcd",
    preset: "7d",
    severity: "CRIT",
  });
  assert.ok(sql7d.includes("INTERVAL '7 DAYS'") || sql7d.includes("7d"));
  assert.ok(sql7d.includes("CRIT"), "SQL must include severity filter");

  const sqlCustom = generateForensicsSql({
    projectId: "proj-1234-abcd",
    customFrom: "2026-10-01T00:00:00Z",
    customTo: "2026-10-15T23:59:59Z",
  });
  assert.ok(sqlCustom.includes("2026-10-01T00:00:00Z"));
  assert.ok(sqlCustom.includes("2026-10-15T23:59:59Z"));
});

test("INV-PF-3: validateProjectId rejects missing, blank, or invalid IDs", () => {
  assert.throws(() => validateProjectId(""), /project id is required/i);
  assert.throws(() => validateProjectId("   "), /project id is required/i);
  assert.doesNotThrow(() => validateProjectId("p-01"));
  assert.doesNotThrow(() => validateProjectId("123e4567-e89b-12d3-a456-426614174000"));
});

test("INV-PF-4: validateSqlQuery rejects empty queries or queries exceeding 8000 characters", () => {
  assert.throws(() => validateSqlQuery(""), /query cannot be empty/i);
  assert.throws(() => validateSqlQuery("   "), /query cannot be empty/i);
  const oversized = "SELECT * FROM logs WHERE id = '" + "x".repeat(8001) + "'";
  assert.throws(() => validateSqlQuery(oversized), /exceeds maximum allowed length/i);
  assert.doesNotThrow(() => validateSqlQuery("SELECT * FROM logs LIMIT 10"));
});

test("INV-PF-5: executeForensicsPipeline calls chat first to generate query, then gives query to query API", async () => {
  const mockQueryRes = {
    columns: ["id", "timestamp", "severity", "source", "details"],
    rows: [
      ["alert-1", "2026-10-18T10:00:00Z", "CRIT", "honeytoken.db", "Honeytoken access detected"],
    ],
  };

  const callOrder = [];
  let queryCalledWith = null;
  let chatCalledWith = null;

  const mockClient = {
    async chat(projectId, payload) {
      callOrder.push("chat");
      chatCalledWith = { projectId, payload };
      return {
        role: "assistant",
        content: "Here is the forensics query to run:\n```sql\nSELECT * FROM sentinel_logs WHERE level = 'CRIT'\n```",
        sql: "SELECT * FROM sentinel_logs WHERE level = 'CRIT'",
      };
    },
    async query(projectId, payload) {
      callOrder.push("query");
      queryCalledWith = { projectId, payload };
      return mockQueryRes;
    },
  };

  const outcome = await executeForensicsPipeline(
    {
      projectId: "proj-123",
      userPrompt: "Investigate critical threats",
      filterRange: "24h",
    },
    mockClient
  );

  assert.deepEqual(callOrder, ["chat", "query"], "Chat must be called first, then query API second");
  assert.equal(chatCalledWith.projectId, "proj-123");
  assert.ok(chatCalledWith.payload.messages[0].content.includes("Investigate critical threats"));
  assert.ok(chatCalledWith.payload.messages[0].content.includes("24h"));

  assert.equal(queryCalledWith.projectId, "proj-123");
  assert.equal(queryCalledWith.payload.sql, "SELECT * FROM sentinel_logs WHERE level = 'CRIT'");

  assert.equal(outcome.generatedSql, "SELECT * FROM sentinel_logs WHERE level = 'CRIT'");
  assert.deepEqual(outcome.queryResult, mockQueryRes);
  assert.ok(outcome.chatText.includes("forensics query to run"));
});

test("INV-PF-6: executeForensicsPipeline halts if Step 1 (chat) fails and does NOT invoke query", async () => {
  let queryInvoked = false;
  const failingClient = {
    async chat() {
      throw new Error("Forensics chat AI service timed out");
    },
    async query() {
      queryInvoked = true;
      return { columns: [], rows: [] };
    },
  };

  await assert.rejects(
    async () => {
      await executeForensicsPipeline(
        {
          projectId: "proj-123",
          userPrompt: "Analyze root cause",
        },
        failingClient
      );
    },
    /timed out/
  );

  assert.equal(queryInvoked, false, "Query API must not be called when chat fails");
});

test("INV-PF-7: extractSqlQueryFromChat extracts SQL from fields, code blocks, or raw statements", () => {
  assert.equal(
    extractSqlQueryFromChat({ sql: "SELECT * FROM alerts" }),
    "SELECT * FROM alerts"
  );
  assert.equal(
    extractSqlQueryFromChat({
      content: "Generated query:\n```sql\nSELECT id, count(*) FROM logs GROUP BY id\n```",
    }),
    "SELECT id, count(*) FROM logs GROUP BY id"
  );
  assert.equal(
    extractSqlQueryFromChat({ content: "Try SELECT * FROM events WHERE status = 'err';" }),
    "SELECT * FROM events WHERE status = 'err';"
  );
  assert.equal(
    extractSqlQueryFromChat({ content: "No query here" }, "SELECT fallback FROM default"),
    "SELECT fallback FROM default"
  );
  // Extracts SQL from JSON string in content
  assert.equal(
    extractSqlQueryFromChat({ content: JSON.stringify({ summary: "Found 2 events", sql: "SELECT * FROM db" }) }),
    "SELECT * FROM db"
  );
});

test("INV-PF-7b: extractChatResponseText extracts human text and never returns raw JSON", () => {
  const jsonString = JSON.stringify({
    summary: "Suspicious login attempts detected from Frankfurt node",
    sql: "SELECT * FROM auth_events",
  });
  const extracted = extractChatResponseText({ content: jsonString });
  assert.ok(extracted.includes("Suspicious login attempts detected"), "Must extract human-readable summary");
  assert.ok(!extracted.startsWith("{"), "Must not return raw JSON");

  const markdownJson = "```json\n" + JSON.stringify({ analysis: "Decoy file accessed at 02:00 UTC", sql: "SELECT 1" }) + "\n```";
  const extractedMd = extractChatResponseText({ content: markdownJson });
  assert.ok(extractedMd.includes("Decoy file accessed at 02:00 UTC"));
});

test("INV-PF-8: validateForensicsMessages enforces 1–20 items and last message role === 'user'", () => {
  assert.throws(() => validateForensicsMessages([]), /at least 1 message/i);

  // Rejects when last message is assistant (would cause 422)
  assert.throws(
    () =>
      validateForensicsMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: "response" },
      ]),
    /role: 'user'/i
  );

  // Passes with valid single user message
  const validSingle = validateForensicsMessages([{ role: "user", content: "First question" }]);
  assert.equal(validSingle.length, 1);
  assert.equal(validSingle[0].role, "user");

  // Rejects when > 20 messages
  const oversized = Array.from({ length: 21 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant"),
    content: `Msg ${i}`,
  }));
  oversized[20].role = "user";
  assert.throws(() => validateForensicsMessages(oversized), /exceeds maximum allowed of 20/i);
});

test("INV-PF-9: sanitizeForensicsMessage enforces max 4000 content, 8000 sql, and sanitizes result", () => {
  const longContent = "A".repeat(5000);
  const longSql = "SELECT " + "B".repeat(9000);

  const sanitizedUser = sanitizeForensicsMessage({
    role: "user",
    content: longContent,
    sql: longSql,
    result: { columns: ["col"], rows: [["cell"]] },
  });

  assert.equal(sanitizedUser.role, "user");
  assert.equal(sanitizedUser.content.length, 4000);
  assert.equal(sanitizedUser.sql.length, 8000);
  // User messages CAN have result attached (e.g. 24h summary result)
  assert.ok(sanitizedUser.result);
  assert.deepEqual(sanitizedUser.result.columns, ["col"]);
  assert.deepEqual(sanitizedUser.result.rows, [["cell"]]);

  const sanitizedAssistant = sanitizeForensicsMessage({
    role: "assistant",
    content: "Assistant analysis",
    sql: "SELECT * FROM db",
    result: { columns: ["col1"], rows: [["val1"]] },
  });

  assert.equal(sanitizedAssistant.role, "assistant");
  assert.ok(sanitizedAssistant.result);
  assert.deepEqual(sanitizedAssistant.result.columns, ["col1"]);
});

test("INV-PF-10: sanitizeForensicsResult cuts rows to first 20, cols to 50, and cells to 200 chars", () => {
  const bigCols = Array.from({ length: 60 }, (_, i) => `col_${i}`);
  const bigRows = Array.from({ length: 30 }, (_, r) =>
    Array.from({ length: 60 }, (_, c) => (c === 0 ? "x".repeat(300) : `cell_${r}_${c}`))
  );

  const sanitized = sanitizeForensicsResult({
    columns: bigCols,
    rows: bigRows,
  });

  assert.ok(sanitized);
  assert.equal(sanitized.columns.length, 50, "Columns must be capped at 50");
  assert.equal(sanitized.rows.length, 20, "Rows sent to model must be capped at 20");
  assert.equal(sanitized.rows[0][0].length, 200, "Cell text must be cut to 200 characters");
});

test("INV-PF-11: buildForensicsHistoryContext preserves up to 19 context items + new user turn", () => {
  // Simulate 10 completed turns (20 messages)
  const tenTurns = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant"),
    content: `Turn ${i}`,
    ...(i % 2 === 1
      ? {
          sql: `SELECT * FROM table_${i}`,
          result: { columns: ["id"], rows: [[`row_${i}`]] },
        }
      : {}),
  }));

  const nextContext = buildForensicsHistoryContext(
    tenTurns,
    "Refine your last query for only error status"
  );

  assert.equal(nextContext.length, 20, "Total context must be exactly 20 items");
  assert.equal(nextContext[19].role, "user", "Last item must have role: 'user'");
  assert.equal(nextContext[19].content, "Refine your last query for only error status");

  // Verify previous assistant item retains drafted SQL & result
  const prevAssistant = nextContext[18];
  assert.equal(prevAssistant.role, "assistant");
  assert.ok(prevAssistant.sql);
  assert.ok(prevAssistant.result);
});

test("INV-PF-12: user message payload sends last queried result (24h summary) & sql to chat, then executes generated query", async () => {
  const summary24hResult = {
    columns: ["event_id", "severity", "count"],
    rows: [["auth_fail", "HIGH", 42]],
  };

  const finalSummaryResult = {
    columns: ["ip", "attempts", "location"],
    rows: [["198.51.100.5", 38, "DE"]],
  };

  let chatPayload = null;
  let finalQueryPayload = null;

  const mockClient = {
    async chat(projectId, payload) {
      chatPayload = payload;
      return {
        role: "assistant",
        content: "Drilling down into the 42 auth failures from the 24h summary:\n```sql\nSELECT ip, count(*) as attempts, location FROM auth_logs WHERE severity = 'HIGH' GROUP BY ip, location\n```",
        sql: "SELECT ip, count(*) as attempts, location FROM auth_logs WHERE severity = 'HIGH' GROUP BY ip, location",
      };
    },
    async query(projectId, payload) {
      finalQueryPayload = payload;
      return finalSummaryResult;
    },
  };

  const outcome = await executeForensicsPipeline(
    {
      projectId: "proj-sec-99",
      userPrompt: "Generate summary of root IPs from the 24h auth failures",
      lastQuerySql: "SELECT event_id, severity, count(*) FROM alerts WHERE timestamp >= NOW() - INTERVAL '24 HOURS' GROUP BY event_id, severity",
      lastQueryResult: summary24hResult,
    },
    mockClient
  );

  // Assert user message sent to chat has content, sql, and the 24h summary result
  assert.equal(chatPayload.messages.length, 1);
  const userMsg = chatPayload.messages[0];
  assert.equal(userMsg.role, "user");
  assert.ok(userMsg.content.includes("Generate summary of root IPs"));
  assert.ok(userMsg.sql.includes("INTERVAL '24 HOURS'"));
  assert.deepEqual(userMsg.result, summary24hResult);

  // Assert generated query was executed on query API to produce final summary
  assert.equal(
    finalQueryPayload.sql,
    "SELECT ip, count(*) as attempts, location FROM auth_logs WHERE severity = 'HIGH' GROUP BY ip, location"
  );
  assert.deepEqual(outcome.queryResult, finalSummaryResult);
});

test("INV-PF-13: the HTTP client sends OpenAPI-shaped chat and query JSON", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    const response = String(url).endsWith("/chat")
      ? { content: "Query ready", sql: "SELECT id FROM events LIMIT 2" }
      : { columns: ["id"], rows: [[1]] };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const projectId = "123e4567-e89b-12d3-a456-426614174000";
    const messages = buildForensicsHistoryContext([], {
      role: "user",
      content: "Investigate authentication failures",
      sql: "SELECT id FROM events LIMIT 2",
      result: { columns: ["id"], rows: [[1]] },
    });
    await forensicsService.chat(projectId, { messages });
    await forensicsService.query(projectId, { sql: "SELECT id FROM events LIMIT 2" });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers["Content-Type"], "application/json");
    assert.ok(requests[0].url.endsWith(`/api/v1/projects/${projectId}/forensics/chat`));
    assert.deepEqual(requests[0].body, { messages: [{
      role: "user",
      content: "Investigate authentication failures",
      sql: "SELECT id FROM events LIMIT 2",
      result: { columns: ["id"], rows: [[1]] },
    }] });
    assert.equal(requests[1].options.method, "POST");
    assert.ok(requests[1].url.endsWith(`/api/v1/projects/${projectId}/forensics/query`));
    assert.deepEqual(requests[1].body, { sql: "SELECT id FROM events LIMIT 2" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("INV-PF-14: new analysis clears all previous records, messages, and cached query results", async () => {
  // Simulated previous analysis history with 4 messages
  const oldHistory = [
    { role: "user", content: "Old question 1" },
    { role: "assistant", content: "Old answer 1", sql: "SELECT 1", result: { columns: ["a"], rows: [[1]] } },
    { role: "user", content: "Old question 2" },
    { role: "assistant", content: "Old answer 2", sql: "SELECT 2", result: { columns: ["b"], rows: [[2]] } },
  ];

  let chatMessagesSent = null;
  const mockClient = {
    async chat(projectId, payload) {
      chatMessagesSent = payload.messages;
      return {
        role: "assistant",
        content: "New analysis response",
        sql: "SELECT * FROM new_table",
      };
    },
    async query() {
      return { columns: ["id"], rows: [["new_row"]] };
    },
  };

  // When starting a new analysis (history reset to empty, no previous query result)
  const outcome = await executeForensicsPipeline(
    {
      projectId: "proj-fresh-001",
      userPrompt: "Brand new inquiry",
      history: [], // Cleared on new analysis
      lastQueryResult: null, // Cleared on new analysis
      lastQuerySql: null, // Cleared on new analysis
    },
    mockClient
  );

  // Assert chat received ONLY the new question with zero previous records
  assert.equal(chatMessagesSent.length, 1);
  assert.equal(chatMessagesSent[0].role, "user");
  assert.equal(chatMessagesSent[0].content, "Brand new inquiry");
  assert.equal(chatMessagesSent[0].result, undefined, "Previous query results must be cleared");
  assert.equal(chatMessagesSent[0].sql, undefined, "Previous query SQL must be cleared");

  // Assert outcome history starts freshly from this new analysis (1 user, 1 assistant)
  assert.equal(outcome.updatedHistory.length, 2);
  assert.equal(outcome.updatedHistory[0].content, "Brand new inquiry");
  assert.equal(outcome.updatedHistory[1].content, "New analysis response");
});

