# Conformance cases

Every SDK runs these eleven cases against `conformance/mock.mjs`. A case that passes in one language and fails in another is a bug.

Run `node conformance/run.mjs`. It starts the mock and runs each language's test with `FRONTMOST_BASE_URL` and `FRONTMOST_API_KEY=fmk_test`.

| # | Call | Mock reply | The SDK must |
|---|---|---|---|
| 1 | `workspace.get()` | 429 with `retry-after: 0`, then 200 | Retry once and return the workspace. The retry sends `x-frontmost-retry-count: 1`. |
| 2 | `questions.list("1")`, every page | Page 1 has 2 questions and `next_cursor: "p2"`. Page 2 has 1 | Return 3 questions in order. Send the cursor of page 1 on the second request. |
| 3 | `projects.get("2")` | 500 every time | Make 3 attempts (2 retries), then raise the internal server error with `code: "internal_error"` and `request_id: "req_500"`. |
| 4 | `projects.get("3")` | 404 | Make 1 attempt. Raise the not-found error with `status: 404`, `code: "not_found"`, the API `message` unchanged, and `request_id: "req_404"`. |
| 5 | `questions.create("1", { questions: [{ text }] })` | 500, then 201 if the key is the same | Send one `Idempotency-Key` on both attempts, and return the new questions. |
| 6 | `profiles.delete("4")` | 204, no body | Return no value without a parse error. |
| 7 | `workspace.get()` with the key `fmk_wrong` | 401 | Make 1 attempt. Raise the authentication error with `code: "invalid_key"`. |
| 8 | `profiles.create("1", { name, who })` | 409 `request_in_progress`, then 201 | Retry once with the same `Idempotency-Key`, and return the profile. |
| 9 | `projects.get("6")` with a 100 ms timeout and 1 retry | No reply for 1 s | Make 2 attempts, then raise the timeout error. |
| 10 | `workspace.get()` at `http://127.0.0.1:9/v1` with 0 retries | No server | Raise the connection error, and not the timeout error. |
| 11 | `projects.createAndWait({ domain })` | 202 with `next`, then 201 | Send `next.body` to `next.path`, with a new `Idempotency-Key`. Return the project. |

Every request sends `Authorization: Bearer <key>`, `x-frontmost-lang`, and `x-frontmost-package-version`.
`GET /__log` on the mock returns each request it saw. `POST /__reset` clears it.
