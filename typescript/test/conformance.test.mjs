// The eleven cases in conformance/README.md. conformance/run.mjs sets FRONTMOST_BASE_URL to the mock.
import assert from "node:assert/strict";
import test from "node:test";
import { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, formatRate, Frontmost, InternalServerError, NotFoundError } from "../dist/index.js";

const base = process.env.FRONTMOST_BASE_URL;
const client = new Frontmost();
const log = async () => (await fetch(base.replace(/\/v1$/, "/__log"))).json();
const reset = () => fetch(base.replace(/\/v1$/, "/__reset"), { method: "POST" });
test.beforeEach(reset);

test("1 retries a 429 and sends the retry count", async () => {
  const w = await client.workspace.get();
  assert.equal(w.name, "Papaya");
  const seen = await log();
  assert.deepEqual(seen.map((r) => r.headers["x-frontmost-retry-count"]), ["0", "1"]);
  for (const r of seen) {
    assert.equal(r.headers.authorization, "Bearer fmk_test");
    assert.equal(r.headers["x-frontmost-lang"], "typescript");
    assert.ok(r.headers["x-frontmost-package-version"]);
  }
});

test("2 reads every page in order", async () => {
  const all = await client.questions.list("1").toArray();
  assert.deepEqual(all.map((q) => q.id), ["1", "2", "3"]);
  assert.match((await log())[1].query, /cursor=p2/);
});

test("3 stops after 2 retries of a 500", async () => {
  await assert.rejects(client.projects.get("2"), (e) => e instanceof InternalServerError && e.code === "internal_error" && e.requestId === "req_500");
  assert.equal((await log()).length, 3);
});

test("4 never retries a 404 and keeps the API message", async () => {
  await assert.rejects(client.projects.get("3"), (e) =>
    e instanceof NotFoundError && e.status === 404 && e.code === "not_found" && e.requestId === "req_404" &&
    e.message === "No project with this ID in this workspace. List projects at /api/v1/projects.");
  assert.equal((await log()).length, 1);
});

test("5 sends one Idempotency-Key on both attempts", async () => {
  const out = await client.questions.create("1", { questions: [{ text: "Which bank is best for students?" }] });
  assert.equal(out.data[0].text, "Which bank is best for students?");
  const keys = (await log()).map((r) => r.headers["idempotency-key"]);
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[0] === keys[1]);
});

test("6 returns nothing for a 204", async () => {
  assert.equal(await client.profiles.delete("4"), undefined);
});

test("7 never retries a 401", async () => {
  const wrong = new Frontmost({ apiKey: "fmk_wrong" });
  await assert.rejects(wrong.workspace.get(), (e) => e instanceof AuthenticationError && e.code === "invalid_key");
  assert.equal((await log()).length, 1);
});

test("8 retries a 409 request_in_progress with the same key", async () => {
  const p = await client.profiles.create("1", { name: "Agency owner", who: "Runs a small agency" });
  assert.equal(p.name, "Agency owner");
  const keys = (await log()).map((r) => r.headers["idempotency-key"]);
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[0] === keys[1]);
});

test("9 retries a timeout, then raises the timeout error", async () => {
  const slow = new Frontmost({ timeout: 100, maxRetries: 1 });
  await assert.rejects(slow.projects.get("6"), (e) => e instanceof APIConnectionTimeoutError);
  assert.equal((await log()).length, 2);
});

test("10 raises the connection error when no server answers", async () => {
  const none = new Frontmost({ baseURL: "http://127.0.0.1:9/v1", maxRetries: 0 });
  await assert.rejects(none.workspace.get(), (e) => e instanceof APIConnectionError && !(e instanceof APIConnectionTimeoutError));
});

test("11 createAndWait follows the 202 to the project", async () => {
  const p = await client.projects.createAndWait({ domain: "papaya.example" });
  assert.equal(p.id, "12");
  const seen = await log();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].body, { setup_id: "12" });
  assert.ok(seen[0].headers["idempotency-key"] && seen[1].headers["idempotency-key"]);
  assert.notEqual(seen[0].headers["idempotency-key"], seen[1].headers["idempotency-key"]);
});

test("12 keeps the fields that an open reply does not name", async () => {
  const scan = await client.scans.get("12", "latest");
  assert.deepEqual(scan.kpis, { visibility: 22 });
});

test("formatRate shows the rate with its counts", () => {
  assert.equal(formatRate({ value: 8 / 36, numerator: 8, denominator: 36, previous: null }), "22% · 8 of 36");
  assert.equal(formatRate({ value: null, numerator: 0, denominator: 0, previous: null }), "No answers");
});
