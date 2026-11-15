# Frontmost AI for Python

Find out when ChatGPT and other AI apps recommend your business, and who they recommend instead. This package gives your code and agents typed access to the [Frontmost AI API](https://app.frontmost.ai/api/v1/openapi.json).

```bash
pip install frontmost
```

It runs on Python 3.9 or later. It has a sync client and an async client, and full type hints.

## Quickstart

Create a key on [the Team page](https://app.frontmost.ai/team), then put it in `FRONTMOST_API_KEY`.

```python
from frontmost import Frontmost, format_rate

client = Frontmost()  # reads FRONTMOST_API_KEY

project = client.projects.list().to_list()[0]
metrics = client.metrics.get(project["id"], period="week", compare_to="previous")

totals = metrics["totals"]
print(format_rate(totals["visibility"] if totals else None))  # 22% · 8 of 36
```

`format_rate` prints a rate with its counts. A rate never travels without them: `visibility` is `{"value": 0.22, "numerator": 8, "denominator": 36, "previous": 0.17}`.

Replies are typed dicts, so your editor knows every key. A full program is in [examples/weekly_report.py](examples/weekly_report.py).

## Read your numbers

```python
metrics = client.metrics.get(
    "90",
    period="month",  # "scan", "week", or "month"
    app="chatgpt",  # one AI app, or leave it out for every app
    questions="unbranded",  # "all", "branded", or "unbranded"
    group_by="app",  # split the numbers by AI app
)

totals = metrics["totals"]
if totals:
    print(format_rate(totals["win_rate"]))
    for group in metrics.get("groups", []):
        print(group.get("app"), format_rate(group["visibility"]))
else:
    print(metrics.get("message"))  # why there is nothing to count yet, such as no delivered scan
```

`metrics["scope"]` says exactly what the numbers count: the scan, the dates, the apps, and the question set.

## Who AI names instead of you

```python
rivals = client.rivals.list("90", period="week").to_list()

for rival in sorted(rivals, key=lambda r: r["named_instead_of_you"], reverse=True):
    print(f"{rival['name']}: named instead of you in {rival['named_instead_of_you']} answers")
```

## Read the answers

Filter the answers, then open one to read its text and citations.

```python
# Answers that cite reddit.com and do not name you.
for answer in client.answers.list("90", cited_domain="reddit.com", named=False):
    full = client.answers.get(answer["id"])
    print(full["question"]["text"])
    print(full["text"])
    print([citation["url"] for citation in full["citations"]])
```

Other filters: `question_id`, `rival_id`, `scan_id`, `period`, `app`, and `questions`.

## Lists and pages

A list method returns a page object. You never handle a cursor unless you want to.

```python
# Every row, one page at a time.
for question in client.questions.list("90"):
    print(question["text"])

# Every row in one list.
sources = client.sources.list("90", channel="reddit").to_list()

# One page, with the list's own fields.
page = client.rivals.list("90", limit=10).page()
print(page["scope"], page["has_more"], page["next_cursor"])
```

## Change what Frontmost AI tracks

```python
# Add buyer questions.
added = client.questions.create(
    "90",
    {"questions": [{"text": "Which AI visibility tool works without a dashboard?", "topic": "Tools"}]},
)

# Pause a question.
client.questions.update("90", added["data"][0]["id"], {"active": False})

# Add a buyer profile.
client.profiles.create("90", {"name": "Agency owner", "who": "Runs a five-person SEO agency"})

# Mark a recommendation as done.
open_items = client.recommendations.list("90", status="open").to_list()
client.recommendations.update(open_items[0]["id"], {"status": "done"})
```

## Add a project

Frontmost AI reads the website before it writes the first questions. `create_and_wait` waits for that and returns the project.

```python
project = client.projects.create_and_wait({"domain": "example.com", "country": "US"})
print(project["url"])
```

`create` returns at once. Its reply is a project, or a setup that tells you when to call again:

```python
reply = client.projects.create({"domain": "example.com"})
if reply["object"] == "project_setup":
    ...  # Wait reply["retry_after"] seconds, then send reply["next"]["body"] to create again.
```

`create_and_wait` stops with an error after 10 minutes. The error message names the call that continues the setup.

## Async

`AsyncFrontmost` has the same methods. Use `await` for a call and `async for` for a list.

```python
import asyncio

from frontmost import AsyncFrontmost


async def main() -> None:
    async with AsyncFrontmost() as client:
        metrics, rivals = await asyncio.gather(
            client.metrics.get("90", period="week"),
            client.rivals.list("90", period="week").to_list(),
        )
        async for answer in client.answers.list("90", named=False, limit=5):
            print(answer["question"]["text"])


asyncio.run(main())
```

## Errors

Each API error is an `APIError` subclass with the status, the API's `code`, its message, and the `request_id`.

```python
from frontmost import APIError, NotFoundError

try:
    client.projects.get("12345")
except NotFoundError as err:
    print(err.message)  # the API says what to do next
except APIError as err:
    print(err.status, err.code, err.request_id)
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

```python
client = Frontmost(max_retries=4, timeout=20.0)

client.metrics.get("90", max_retries=0, timeout=5.0)
```

## Safe writes

Each POST carries an `Idempotency-Key`. A retry sends the same key, so the API does the work once. To make your own retries safe too, pass your own key:

```python
client.questions.create("90", body, idempotency_key="questions-2026-11-16")
```

## Configuration

| Argument | Default |
| --- | --- |
| `api_key` | `FRONTMOST_API_KEY` |
| `base_url` | `FRONTMOST_BASE_URL`, then `https://app.frontmost.ai/api/v1` |
| `max_retries` | `2` |
| `timeout` | `60.0` seconds per attempt |
| `default_headers` | None |
| `http_client` | A new `httpx.Client` (`httpx.AsyncClient` for `AsyncFrontmost`) |

Every method also takes `max_retries`, `timeout`, `idempotency_key`, and `extra_headers` as keyword arguments. Close the client with `client.close()`, or use it in a `with` block.

## Types

Every request and reply has a `TypedDict`, exported by name: `Metrics`, `Rival`, `AnswerSummary`, `Answer`, `Rate`, `Scope`, and the rest. A list of values, such as `Channel`, is a `Literal`. The API can add a value to a list, so handle the values you do not know.

## Versions

This package follows [semver](https://semver.org). A new field never breaks your code. A removed or changed field comes only in a new major version, or a new minor version before 1.0. The code is generated from the API's OpenAPI file in [frontmost-ai/sdks](https://github.com/frontmost-ai/sdks).

## License

MIT
