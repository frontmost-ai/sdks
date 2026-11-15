# Frontmost AI SDKs

Find out when ChatGPT and other AI apps recommend your business, and who they recommend instead. Then act on it from your own code and agents.

These are the official TypeScript, Python, and Rust clients for the [Frontmost AI API](https://app.frontmost.ai/api/v1/openapi.json).

| Language | Install | Docs |
| --- | --- | --- |
| TypeScript | `npm install @frontmost-ai/sdk` | [typescript/README.md](typescript/README.md) |
| Python | `pip install frontmost` | [python/README.md](python/README.md) |
| Rust | `cargo add frontmost-ai` | [rust/README.md](rust/README.md) |

## Get a key

1. Open [the Team page](https://app.frontmost.ai/team) in Frontmost AI.
2. Create an API key.
3. Put it in `FRONTMOST_API_KEY`. Every SDK reads it from there.

```bash
export FRONTMOST_API_KEY=fmk_...
```

## Quickstart

The same task in each language: how often AI apps named you this week, out of how many answers.

**TypeScript**

```ts
import Frontmost, { formatRate } from "@frontmost-ai/sdk";

const client = new Frontmost();
const metrics = await client.metrics.get("90", { period: "week" });

console.log(formatRate(metrics.totals?.visibility ?? null)); // 22% · 8 of 36
```

**Python**

```python
from frontmost import Frontmost, format_rate

client = Frontmost()
metrics = client.metrics.get("90", period="week")

totals = metrics["totals"]

print(format_rate(totals["visibility"] if totals else None))  # 22% · 8 of 36
```

**Rust**

```rust
use frontmost_ai::{format_rate, Client, MetricsGetParams, Period};

let client = Client::new()?;
let params = MetricsGetParams { period: Some(Period::Week), ..Default::default() };
let metrics = client.metrics().get("90", Some(params), None).await?;

println!("{}", format_rate(metrics.totals.as_ref().map(|t| &t.visibility))); // 22% · 8 of 36
```

Each folder has a full example program: [weekly-report.ts](typescript/examples/weekly-report.ts), [weekly_report.py](python/examples/weekly_report.py), and [weekly_report.rs](rust/examples/weekly_report.rs).

## What you can ask

| Resource | Answers the question |
| --- | --- |
| `metrics` | How often do AI apps name me, put me first, and speak well of me? |
| `rivals` | Who do AI apps name instead of me, and how often? |
| `answers` | What exactly did each AI app say, and which sites did it cite? |
| `sources` | Which sites do AI apps read when they answer my buyers? |
| `recommendations` | What should I change next, and did the last change work? |
| `questions` | Which buyer questions does Frontmost AI ask the AI apps? |
| `profiles` | Which kinds of buyer do I track? |
| `scans` | When did each set of answers arrive? |
| `projects` | Which websites do I track? Add a new one. |
| `workspace` | Which plan am I on, and how much of it have I used? |

Every number comes with its counts. A rate is `{ value, numerator, denominator, previous }`, so `0.22` is always "8 of 36 answers", never a bare percentage.

## The same behavior in every language

- **Retries.** A failed call is sent again up to 2 times: on a timeout, a lost connection, 408, 429, a 5xx, and a 409 that says the same request is still running. The wait follows `Retry-After`, else 0.5 s doubling to 8 s.
- **Safe writes.** Each POST carries an `Idempotency-Key`. A retry sends the same key, so a retry never adds a question twice.
- **Pages.** A list method returns a page object. Loop over it to read every row, and the SDK fetches the next page when it needs one.
- **Errors.** An API error has its HTTP status, a `code` such as `not_found`, the API's own message, and a `request_id` to give to support.
- **Long work.** `projects.create` returns a setup that is still running. `createAndWait` (`create_and_wait` in Python and Rust) waits for it and returns the project.
- **New values.** The API can add a value to a list of values, such as a new AI app or channel. Each SDK reads a value that it does not know without an error.

## How the SDKs stay current

The Frontmost AI API describes itself in one OpenAPI file. This repository generates all three SDKs from that file, so a new field arrives in every language at the same time.

- Before an API change merges, `codegen/sync.mjs` checks it. A removed field or a changed type is a break and stops the merge.
- Every hour, the [release workflow](.github/workflows/release.yml) reads the live spec. When it changed, the workflow regenerates the SDKs, runs every test, and publishes a new version of all three.
- Versions follow [semver](https://semver.org). A new field never breaks your code. A removed or changed field comes only in a new major version, or a new minor version before 1.0.

## Work on this repository

You need Node 20, Python 3.9 or later with [uv](https://docs.astral.sh/uv/), and stable Rust.

```bash
node codegen/generate.mjs      # write the three generated files from spec/openapi.json
node conformance/run.mjs       # run the shared cases against the mock API in all three languages
```

| Path | What it holds | Who edits it |
| --- | --- | --- |
| `spec/openapi.json` | The released API description | `codegen/sync.mjs --write` |
| `codegen/ir.mjs` | Reads the spec into one list of operations for every language | People |
| `codegen/{typescript,python,rust}.mjs` | Write each SDK's types and methods | People |
| `typescript/src/core.ts`, `python/src/frontmost/_core.py`, `rust/src/core.rs` | Retries, errors, pages, and idempotency keys | People |
| `typescript/src/generated.ts`, `python/src/frontmost/_generated.py`, `rust/src/generated.rs` | Types and methods | The generator only |
| `conformance/` | Eleven shared cases and a mock API that every SDK must pass | People |

Check a new spec before it merges:

```bash
node codegen/sync.mjs path/to/openapi.json
```

It prints the breaks and the version bump. Then it regenerates all three SDKs in a temporary copy and runs the conformance cases. Exit code 1 means a break or a failed case. Add `--write` to keep the result.

[RELEASING.md](RELEASING.md) says how a release reaches npm, PyPI, and crates.io.

## License

[MIT](LICENSE)
