# Frontmost AI for Rust

Find out when ChatGPT and other AI apps recommend your business, and who they recommend instead. This crate gives your code and agents typed, async access to the [Frontmost AI API](https://app.frontmost.ai/api/v1/openapi.json).

```bash
cargo add frontmost-ai
```

It runs on Tokio and uses `rustls` for TLS. The examples also use Tokio's macros and `futures::StreamExt`:

```bash
cargo add tokio --features macros,rt-multi-thread
```

```bash
cargo add futures
```

## Quickstart

Create a key on [the Team page](https://app.frontmost.ai/team), then put it in `FRONTMOST_API_KEY`.

```rust
use frontmost_ai::{format_rate, Client, CompareTo, MetricsGetParams, Period};

#[tokio::main]
async fn main() -> Result<(), frontmost_ai::Error> {
    let client = Client::new()?; // reads FRONTMOST_API_KEY

    let projects = client.projects().list(None, None).collect_all().await?;
    let params = MetricsGetParams {
        period: Some(Period::Week),
        compare_to: Some(CompareTo::Previous),
        ..Default::default()
    };
    let metrics = client.metrics().get(&projects[0].id, Some(params), None).await?;

    println!("{}", format_rate(metrics.totals.as_ref().map(|t| &t.visibility))); // 22% · 8 of 36
    Ok(())
}
```

`format_rate` prints a rate with its counts. A rate never travels without them: `visibility` is `Rate { value: Some(0.22), numerator: 8, denominator: 36, previous: Some(0.17) }`.

Every method takes its path IDs first, then a `Params` or `Body` struct where it has one, then `Option<RequestOptions>`. Each struct implements `Default`, so set only the fields you need.

A full program is in [examples/weekly_report.rs](examples/weekly_report.rs).

## Read your numbers

```rust
use frontmost_ai::{GroupBy, QuestionSet};

let params = MetricsGetParams {
    period: Some(Period::Month),
    app: Some("chatgpt".into()),             // one AI app, or None for every app
    questions: Some(QuestionSet::Unbranded), // All, Branded, or Unbranded
    group_by: Some(GroupBy::App),            // split the numbers by AI app
    ..Default::default()
};
let metrics = client.metrics().get("90", Some(params), None).await?;

match &metrics.totals {
    Some(totals) => {
        println!("{}", format_rate(Some(&totals.win_rate)));
        for group in metrics.groups.iter().flatten() {
            println!("{:?} {}", group.app, format_rate(Some(&group.visibility)));
        }
    }
    // Why there is nothing to count yet, such as no delivered scan.
    None => println!("{}", metrics.message.as_deref().unwrap_or_default()),
}
```

`metrics.scope` says exactly what the numbers count: the scan, the dates, the apps, and the question set.

## Who AI names instead of you

```rust
use frontmost_ai::RivalsListParams;

let params = RivalsListParams { period: Some(Period::Week), ..Default::default() };
let mut rivals = client.rivals().list("90", Some(params), None).collect_all().await?;
rivals.sort_by_key(|rival| std::cmp::Reverse(rival.named_instead_of_you));

for rival in &rivals {
    println!("{}: named instead of you in {} answers", rival.name, rival.named_instead_of_you);
}
```

## Read the answers

Filter the answers, then open one to read its text and citations.

```rust
use frontmost_ai::AnswersListParams;
use futures::StreamExt;

// Answers that cite reddit.com and do not name you.
let params = AnswersListParams {
    cited_domain: Some("reddit.com".into()),
    named: Some(false),
    ..Default::default()
};
let mut answers = Box::pin(client.answers().list("90", Some(params), None).stream());
while let Some(answer) = answers.next().await {
    let full = client.answers().get(&answer?.id, None).await?;
    println!("{}", full.question.text);
    println!("{}", full.text.unwrap_or_default());
    for citation in &full.citations {
        println!("{}", citation.url);
    }
}
```

Other filters: `question_id`, `rival_id`, `scan_id`, `period`, `app`, and `questions`.

## Lists and pages

A list method returns a `Page`. You never handle a cursor unless you want to.

```rust
use frontmost_ai::{Channel, SourcesListParams};

// Every row in one Vec.
let questions = client.questions().list("90", None, None).collect_all().await?;

// Every row as a stream, one page at a time.
let mut stream = Box::pin(client.questions().list("90", None, None).stream());
while let Some(question) = stream.next().await {
    println!("{}", question?.text);
}

// A filtered list.
let params = SourcesListParams { channel: Some(Channel::Reddit), ..Default::default() };
let sources = client.sources().list("90", Some(params), None).collect_all().await?;

// One page, with the list's own fields.
let params = RivalsListParams { limit: Some(10), ..Default::default() };
let page = client.rivals().list("90", Some(params), None).page(None).await?;
println!("{} {:?}", page.has_more, page.next_cursor);
```

## Change what Frontmost AI tracks

```rust
use frontmost_ai::{
    ProfilesCreateBody, QuestionsCreateBody, QuestionsCreateBodyQuestion, QuestionsUpdateBody,
    RecommendationStatus, RecommendationsListParams, RecommendationsUpdateBody,
};

// Add buyer questions.
let body = QuestionsCreateBody {
    questions: vec![QuestionsCreateBodyQuestion {
        text: "Which AI visibility tool works without a dashboard?".into(),
        ..Default::default()
    }],
};
let added = client.questions().create("90", body, None).await?;

// Pause a question.
let body = QuestionsUpdateBody { active: Some(false), ..Default::default() };
client.questions().update("90", &added.data[0].id, body, None).await?;

// Add a buyer profile.
let body = ProfilesCreateBody {
    name: "Agency owner".into(),
    who: Some("Runs a five-person SEO agency".into()),
};
client.profiles().create("90", body, None).await?;

// Mark a recommendation as done.
let params = RecommendationsListParams { status: Some(RecommendationStatus::Open), ..Default::default() };
let open = client.recommendations().list("90", Some(params), None).collect_all().await?;
let body = RecommendationsUpdateBody { status: RecommendationStatus::Done };
client.recommendations().update(&open[0].id, body, None).await?;
```

## Add a project

Frontmost AI reads the website before it writes the first questions. `create_and_wait` waits for that and returns the project.

```rust
use frontmost_ai::ProjectsCreateBody;

let body = ProjectsCreateBody {
    domain: Some("example.com".into()),
    country: Some("US".into()),
    ..Default::default()
};
let project = client.projects().create_and_wait(body, None).await?;
println!("{}", project.url);
```

`create` returns at once. Its reply is a project, or a setup that tells you when to call again:

```rust
use frontmost_ai::ProjectsCreateReply;

let body = ProjectsCreateBody { domain: Some("example.com".into()), ..Default::default() };
match client.projects().create(body, None).await? {
    ProjectsCreateReply::Project(project) => println!("{}", project.url),
    // Wait setup.retry_after seconds, then send setup.next.body to create again.
    ProjectsCreateReply::ProjectSetup(setup) => println!("{} s", setup.retry_after),
}
```

`create_and_wait` stops with a `Timeout` error after 10 minutes. The error message names the call that continues the setup.

## Errors

Every method returns `Result<T, frontmost_ai::Error>`. An `Error` has a `kind`, and for an API reply also the `status`, the API's `code`, its `message`, and the `request_id`.

```rust
use frontmost_ai::ErrorKind;

match client.projects().get("12345", None).await {
    Ok(project) => println!("{}", project.name),
    Err(err) if err.kind == ErrorKind::NotFound => println!("{}", err.message), // the API says what to do next
    Err(err) => println!("{:?} {:?} {:?}", err.status, err.code, err.request_id),
}
```

| Status | `ErrorKind` |
| --- | --- |
| 400 | `BadRequest` |
| 401 | `Authentication` |
| 403 | `PermissionDenied` |
| 404 | `NotFound` |
| 409 | `Conflict` |
| 422 | `UnprocessableEntity` |
| 429 | `RateLimit` |
| 5xx | `InternalServer` |
| Another status | `Api` |
| No reply | `Connection` |
| No reply in time | `Timeout` |
| No API key | `Config` |

## Retries and timeouts

The client sends a failed call again up to 2 times: on a timeout, a lost connection, 408, 429, a 5xx, and a 409 that says the same request is still running. It waits as long as `Retry-After` says, up to 60 seconds. With no `Retry-After`, it waits 0.5 s and doubles each time, up to 8 s.

Each attempt has 60 seconds. Change either value for the client or for one call:

```rust
use std::time::Duration;
use frontmost_ai::{ClientOptions, RequestOptions};

let client = Client::with_options(ClientOptions {
    max_retries: Some(4),
    timeout: Some(Duration::from_secs(20)),
    ..Default::default()
})?;

let once = RequestOptions { max_retries: Some(0), timeout: Some(Duration::from_secs(5)), ..Default::default() };
client.metrics().get("90", None, Some(once)).await?;
```

## Safe writes

Each POST carries an `Idempotency-Key`. A retry sends the same key, so the API does the work once. To make your own retries safe too, pass your own key:

```rust
let options = RequestOptions { idempotency_key: Some("questions-2026-11-16".into()), ..Default::default() };
client.questions().create("90", body, Some(options)).await?;
```

## Configuration

| `ClientOptions` field | Default |
| --- | --- |
| `api_key` | `FRONTMOST_API_KEY` |
| `base_url` | `FRONTMOST_BASE_URL`, then `https://app.frontmost.ai/api/v1` |
| `max_retries` | `2` |
| `timeout` | 60 seconds per attempt |

`RequestOptions` sets `max_retries`, `timeout`, and `idempotency_key` for one call.

## Types

Every request and reply is a struct that implements `Serialize` and `Deserialize`: `Metrics`, `Rival`, `AnswerSummary`, `Answer`, `Rate`, `Scope`, and the rest. A list of values, such as `Channel`, is an enum. The API can add a value to a list, and the enum reads a value that it does not know as `Unknown`.

## Versions

This crate follows [semver](https://semver.org). A new field never breaks your code. A removed or changed field comes only in a new major version, or a new minor version before 1.0. The code is generated from the API's OpenAPI file in [frontmost-ai/sdks](https://github.com/frontmost-ai/sdks).

## License

MIT
