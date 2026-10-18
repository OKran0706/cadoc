import test from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue } from "../src/lib/ai/redact.ts";

const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACD3sP1k
-----END OPENSSH PRIVATE KEY-----`;

// INV-AI-4: nothing secret reaches the LLM
test("INV-AI-4: private key blocks are removed, including truncated ones", () => {
  const { text, count } = redactText(`before\n${PEM}\nafter`);
  assert.ok(!text.includes("b3BlbnNzaC1r"), "key body must be gone");
  assert.ok(text.includes("before") && text.includes("after"));
  assert.ok(count >= 1);
  const truncated = redactText("x -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7bq");
  assert.ok(!truncated.text.includes("MIIEowIB"));
});

test("INV-AI-4: passwords, tokens, api keys and env values are redacted but keys/names remain", () => {
  const input = [
    "DB_PASSWORD=hunter2hunter2",
    "api_key: sk-live-abcdefghijklmnop1234",
    'password="p@ss w0rd"',
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "Authorization: Bearer abcdef0123456789abcdef0123456789",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "SECRET_TOKEN: 9f8e7d6c5b4a",
  ].join("\n");
  const { text } = redactText(input);
  for (const leaked of ["hunter2", "sk-live", "p@ss", "AKIAIOSFODNN7", "abcdef0123456789abcdef", "ghp_abcdef", "9f8e7d6c"]) {
    assert.ok(!text.includes(leaked), `leaked: ${leaked}`);
  }
  assert.ok(text.includes("DB_PASSWORD"), "variable names are useful context and stay");
});

test("INV-AI-4: JWTs and credentials in connection strings are redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const { text } = redactText(`token ${jwt} and postgres://admin:s3cr3tpw@db.internal:5432/app`);
  assert.ok(!text.includes("eyJhbGci"));
  assert.ok(!text.includes("s3cr3tpw"));
  assert.ok(text.includes("db.internal"), "host is metadata and stays");
});

test("INV-AI-4: .env style files lose every value", () => {
  const { text } = redactText("APP_NAME=shop\nREGION=eu-west-1\nSTRIPE_KEY=whatever");
  assert.ok(!text.includes("shop") && !text.includes("eu-west-1") && !text.includes("whatever"));
  assert.ok(text.includes("APP_NAME") && text.includes("REGION"));
});

test("INV-AI-4: hashes, paths and timestamps are preserved", () => {
  const input = `file /var/www/.env.bak sha256 ${"ab12".repeat(16)} at 2026-10-18T11:59:00Z status: tampered`;
  const { text, count } = redactText(input);
  assert.equal(text, input);
  assert.equal(count, 0);
});

test("INV-AI-4: redactValue walks nested objects/arrays and redacts by key name", () => {
  const { value, count } = redactValue({
    id: "alt-1",
    details: {
      path: "/etc/app/.env",
      password: "hunter2",
      api_key: "abc",
      file_content: "TOP=SECRET",
      nested: [{ token: "t0k3n", note: "password=oops here" }],
    },
    n: 5,
    ok: true,
    nothing: null,
  });
  const s = JSON.stringify(value);
  for (const leaked of ["hunter2", "t0k3n", "oops", "TOP=SECRET", '"abc"']) assert.ok(!s.includes(leaked), `leaked ${leaked}`);
  assert.equal(value.details.path, "/etc/app/.env");
  assert.equal(value.n, 5);
  assert.equal(value.nothing, null);
  assert.ok(count >= 4);
});

test("INV-AI-4: redaction is idempotent and does not mutate its input", () => {
  const original = { details: { password: "x1y2z3" } };
  const once = redactValue(original).value;
  assert.equal(original.details.password, "x1y2z3");
  assert.deepEqual(redactValue(once).value, once);
  assert.equal(redactText(redactText("password=abc12345").text).text, redactText("password=abc12345").text);
});
