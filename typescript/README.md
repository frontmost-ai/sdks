# Frontmost AI for TypeScript

Find out when ChatGPT and other AI apps recommend your business, and who they recommend instead. This package gives your code and agents typed access to the [Frontmost AI API](https://app.frontmost.ai/api/v1/openapi.json).

```bash
npm install https://github.com/frontmost-ai/sdks/releases/download/v0.1.0/frontmost-ai-sdk-0.1.0.tgz
```

Version 0.1.0 installs from [its GitHub release](https://github.com/frontmost-ai/sdks/releases/tag/v0.1.0). The packages go on npm, PyPI, and crates.io next.

It runs on Node 20 or later, Bun, and Deno. It has no dependencies.

## Quickstart

Create a key on [the Team page](https://app.frontmost.ai/team), then put it in `FRONTMOST_API_KEY`.

```ts
import Frontmost, { formatRate } from "@frontmost-ai/sdk";

const client = new Frontmost(); // reads FRONTMOST_API_KEY

const [project] = await client.projects.list().toArray();
const metrics = await client.metrics.get(project.id, { period: "week", compare_to: "previous" });

console.log(formatRate(metrics.totals?.visibility ?? null)); // 22% · 8 of 36
```

`formatRate` prints a rate with its counts. A rate never travels without them: `visibility` is `{ value: 0.22, numerator: 8, denominator: 36, previous: 0.17 }`.

A full program is in [examples/weekly-report.ts](examples/weekly-report.ts).

## Read your numbers

```ts
const metrics = await client.metrics.get("90", {
  period: "month", // "scan", "week", or "month"
  app: "chatgpt", // one AI app, or leave it out for every app
  questions: "unbranded", // "all", "branded", or "unbranded"
  group_by: "app", // split the numbers by AI app
});

if (metrics.totals) {
  console.log(formatRate(metrics.totals.win_rate));
  for (const group of metrics.groups ?? []) console.log(group.app, formatRate(group.visibility));
} else {
  console.log(metrics.message); // why there is nothing to count yet, such as no delivered scan
}
```

`metrics.scope` says exactly what the numbers count: the scan, the dates, the apps, and the question set.

## Who AI names instead of you

```ts
const rivals = await client.rivals.list("90", { period: "week" }).toArray();

for (const rival of rivals.sort((a, b) => b.named_instead_of_you - a.named_instead_of_you)) {
  console.log(`${rival.name}: named instead of you in ${rival.named_instead_of_you} answers`);
}
```

## Read the answers

Filter the answers, then open one to read its text and citations.

```ts
// Answers that cite reddit.com and do not name you.
for await (const answer of client.answers.list("90", { cited_domain: "reddit.com", named: false })) {
  const full = await client.answers.get(answer.id);
  console.log(full.question.text);
  console.log(full.text);
  console.log(full.citations.map((c) => c.url));
}
```

Other filters: `question_id`, `rival_id`, `scan_id`, `period`, `app`, and `questions`.

## Lists and pages

A list method returns a `Page`. You never handle a cursor unless you want to.

```ts
// Every row, one page at a time.
for await (const question of client.questions.list("90")) console.log(question.text);

// Every row in one array.
const sources = await client.sources.list("90", { channel: "reddit" }).toArray();

// One page, with the list's own fields.
const page = await client.rivals.list("90", { limit: 10 }).page();
console.log(page.scope?.period.start, page.has_more, page.next_cursor);
```

## Change what Frontmost AI tracks

```ts
// Add buyer questions.
const added = await client.questions.create("90", {
  questions: [{ text: "Which AI visibility tool works without a dashboard?", topic: "Tools" }],
});

// Pause a question.
await client.questions.update("90", added.data[0].id, { active: false });

// Add a buyer profile.
await client.profiles.create("90", { name: "Agency owner", who: "Runs a five-person SEO agency" });

// Mark a recommendation as done.
const [next] = await client.recommendations.list("90", { status: "open" }).toArray();
await client.recommendations.update(next.id, { status: "done" });
```

## Add a project

Frontmost AI reads the website before it writes the first questions. `createAndWait` waits for that and returns the project.

```ts
const project = await client.projects.createAndWait({ domain: "example.com", country: "US" });
console.log(project.url);
```

`create` returns at once. Its reply is a `Project`, or a `ProjectSetup` that tells you when to call again:

```ts
const reply = await client.projects.create({ domain: "example.com" });
if (reply.object === "project_setup") {
  // Wait reply.retry_after seconds, then send reply.next.body to create again.
}
```

`createAndWait` stops with an error after 10 minutes. The error message names the call that continues the setup.

## Errors

Each API error is an `APIError` subclass with the status, the API's `code`, its message, and the `requestId`.

```ts
import { APIError, NotFoundError, RateLimitError } from "@frontmost-ai/sdk";

try {
  await client.projects.get("12345");
} catch (err) {
  if (err instanceof NotFoundError) console.log(err.message); // the API says what to do next
  else if (err instanceof APIError) console.log(err.status, err.code, err.requestId);
  else throw err;
}
```

| Status | Class |
| --- | --- |
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` |
| 5xx | `InternalServerError` |
| No reply | `APIConnectionError` |
| No reply in time | `APIConnectionTimeoutError` |

All of them extend `FrontmostError`.

## Retries and timeouts

The client sends a failed call again up to 2 times: on a timeout, a lost connection, 408, 429, a 5xx, and a 409 that says the same request is still running. It waits as long as `Retry-After` says, up to 60 seconds. With no `Retry-After`, it waits 0.5 s and doubles each time, up to 8 s.

Each attempt has 60 seconds. Change either value for the client or for one call:

```ts
const client = new Frontmost({ maxRetries: 4, timeout: 20_000 });

await client.metrics.get("90", {}, { maxRetries: 0, timeout: 5_000 });
```

Cancel a call with an `AbortSignal`:

```ts
await client.answers.get("381", { signal: AbortSignal.timeout(2_000) });
```

## Safe writes

Each POST carries an `Idempotency-Key`. A retry sends the same key, so the API does the work once. To make your own retries safe too, pass your own key:

```ts
await client.questions.create("90", body, { idempotencyKey: "questions-2026-11-16" });
```

## Configuration

| Option | Default |
| --- | --- |
| `apiKey` | `FRONTMOST_API_KEY` |
| `baseURL` | `FRONTMOST_BASE_URL`, then `https://app.frontmost.ai/api/v1` |
| `maxRetries` | `2` |
| `timeout` | `60000` ms per attempt |
| `fetch` | The global `fetch` |
| `defaultHeaders` | None |

Every method takes a last `options` argument with `maxRetries`, `timeout`, `idempotencyKey`, `signal`, and `headers`.

## Types

Every request and reply has a type, exported by name: `Metrics`, `Rival`, `AnswerSummary`, `Answer`, `Rate`, `Scope`, and the rest. A list of values, such as `Channel`, is a string union. The API can add a value to a union, so handle the values you do not know.

## Versions

This package follows [semver](https://semver.org). A new field never breaks your code. A removed or changed field comes only in a new major version, or a new minor version before 1.0. The code is generated from the API's OpenAPI file in [frontmost-ai/sdks](https://github.com/frontmost-ai/sdks).

## License

MIT
