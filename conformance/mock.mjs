// A fake Frontmost AI API for the conformance cases in conformance/README.md. No dependencies.
// `node conformance/mock.mjs` prints the base URL on its first line, then serves until stopped.

import { createServer } from "node:http";

const workspace = {
  object: "workspace", id: "7", name: "Papaya", plan: "starter", key_kind: "full",
  questions: { used: 3, max: 50 }, projects: { used: 1, max: 1 }, profiles: { max_per_project: 5 },
  apps: ["chatgpt"], scanning: true, scan_cadence: "daily",
};
const question = (id, text) => ({ object: "question", id, text, topic: "Business", active: true, is_branded: false, profile_id: null });
const error = (code, message, request_id) => ({ error: { code, message, param: null, request_id } });
const project = { object: "project", id: "12", name: "Papaya", domain: "papaya.example", apps: ["chatgpt"], scanning: true, created_at: "2026-11-14T00:00:00Z", url: "https://app.frontmost.ai/projects/12" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let log = [];
let counts = {};
let firstKey = null;

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": `req_${status}`, ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (url.pathname === "/__log") return reply(res, 200, log);
  if (url.pathname === "/__reset") return (log = [], counts = {}, firstKey = null, reply(res, 200, {}));

  const key = `${req.method} ${url.pathname}`;
  const n = (counts[key] = (counts[key] ?? 0) + 1);
  log.push({ method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null, headers: {
    authorization: req.headers.authorization ?? null,
    "idempotency-key": req.headers["idempotency-key"] ?? null,
    "x-frontmost-lang": req.headers["x-frontmost-lang"] ?? null,
    "x-frontmost-package-version": req.headers["x-frontmost-package-version"] ?? null,
    "x-frontmost-retry-count": req.headers["x-frontmost-retry-count"] ?? null,
  } });

  if (req.headers.authorization !== "Bearer fmk_test") return reply(res, 401, error("invalid_key", "The key is missing or unknown.", "req_401"));

  switch (key) {
    // Case 1: a 429 with Retry-After, then success.
    case "GET /v1/workspace":
      return n === 1 ? reply(res, 429, error("rate_limited", "Too many requests.", "req_429"), { "retry-after": "0" }) : reply(res, 200, workspace);
    // Case 2: two pages.
    case "GET /v1/projects/1/questions": {
      const second = url.searchParams.get("cursor") === "p2";
      if (url.searchParams.get("cursor") && !second) return reply(res, 422, error("invalid_cursor", "The cursor belongs to another list.", "req_422"));
      return reply(res, 200, second
        ? { object: "list", data: [question("3", "Which bank is best for a mortgage?")], has_more: false, next_cursor: null }
        : { object: "list", data: [question("1", "Which bank is best for freelancers?"), question("2", "Which bank has the best business account?")], has_more: true, next_cursor: "p2" });
    }
    // Case 3: a 500 every time.
    case "GET /v1/projects/2":
      return reply(res, 500, error("internal_error", "Retry with backoff.", "req_500"));
    // Case 4: a 404, never retried.
    case "GET /v1/projects/3":
      return reply(res, 404, error("not_found", "No project with this ID in this workspace. List projects at /api/v1/projects.", "req_404"));
    // Case 5: a 500, then a retry that must carry the same Idempotency-Key.
    case "POST /v1/projects/1/questions": {
      const k = req.headers["idempotency-key"];
      if (!k) return reply(res, 422, error("invalid_param", "This call needs an Idempotency-Key header.", "req_422"));
      if (n === 1) return (firstKey = k, reply(res, 500, error("internal_error", "Retry with backoff.", "req_500")));
      if (k !== firstKey) return reply(res, 409, error("idempotency_conflict", "This Idempotency-Key was used with another body.", "req_409"));
      const body = JSON.parse(raw);
      return reply(res, 201, { object: "list", data: body.questions.map((q, i) => ({ ...question(String(10 + i), q.text), created: true })), has_more: false, next_cursor: null });
    }
    // Case 6: a DELETE returns 204 with no body.
    case "DELETE /v1/profiles/4":
      return reply(res, 204, undefined);
    // Case 8: a 409 that says the same request is still running, then 201.
    case "POST /v1/projects/1/profiles": {
      const body = JSON.parse(raw);
      return n === 1
        ? reply(res, 409, error("request_in_progress", "A request with this Idempotency-Key is still running. Retry shortly.", "req_409"), { "retry-after": "0" })
        : reply(res, 201, { object: "profile", id: "4", project_id: "1", name: body.name, who: body.who ?? "" });
    }
    // Case 9: no reply within the client timeout.
    case "GET /v1/projects/6":
      await sleep(1000);
      return reply(res, 200, project);
    // Case 11: a 202 that says to wait, then 201 for the follow-up call in `next`.
    case "POST /v1/projects": {
      const body = JSON.parse(raw);
      if (body.setup_id === "12") return reply(res, 201, project);
      return reply(res, 202, { object: "project_setup", id: "12", status: "drafting", domain: body.domain, retry_after: 0, next: { method: "POST", path: "/v1/projects", body: { setup_id: "12" } } });
    }
    default:
      return reply(res, 404, error("not_found", `The mock has no case for ${key}.`, "req_mock"));
  }
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${server.address().port}/v1`);
});
