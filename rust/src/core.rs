// Hand-written runtime. The generator never writes this file. It holds what every route shares:
// the key, retries, timeouts, errors, idempotency keys, and cursor pages.

use std::marker::PhantomData;
use std::time::Duration;

use futures::{stream, Stream, TryStreamExt};
use reqwest::header::HeaderMap;
use reqwest::{Method, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_BASE_URL: &str = "https://app.frontmost.ai/api/v1";
/// The longest time a `..._and_wait` method waits before it stops with an error.
const WAIT_LIMIT: Duration = Duration::from_secs(600);

/// Settings for [`Client::with_options`]. Every field left as `None` takes its default.
#[derive(Debug, Clone, Default)]
pub struct ClientOptions {
    /// Default: FRONTMOST_API_KEY.
    pub api_key: Option<String>,
    /// Default: FRONTMOST_BASE_URL, then https://app.frontmost.ai/api/v1.
    pub base_url: Option<String>,
    /// Retries after the first attempt. Default 2.
    pub max_retries: Option<u32>,
    /// Time for one attempt. Default 60 seconds.
    pub timeout: Option<Duration>,
}

/// Settings for one call. Every method takes `Option<RequestOptions>` as its last argument.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    pub max_retries: Option<u32>,
    pub timeout: Option<Duration>,
    /// Default for a POST: a new random key, sent again on each retry of that call.
    pub idempotency_key: Option<String>,
}

/// What went wrong. API replies map to one kind per status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    BadRequest,
    Authentication,
    PermissionDenied,
    NotFound,
    Conflict,
    UnprocessableEntity,
    RateLimit,
    InternalServer,
    /// An API error reply with a status that has no kind of its own.
    Api,
    Connection,
    Timeout,
    /// The client has no API key, or the HTTP client could not start.
    Config,
    /// A success reply that is not the expected JSON.
    Json,
}

/// An error. For an API reply, `message` is the API's own text, which says what to do next.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub kind: ErrorKind,
    /// The HTTP status, for an API reply.
    pub status: Option<u16>,
    /// The API's error code, such as `not_found`. `unknown_error` when the reply has none.
    pub code: Option<String>,
    pub message: String,
    pub param: Option<String>,
    pub request_id: Option<String>,
}

impl Error {
    fn new(kind: ErrorKind, message: String) -> Self {
        Error {
            kind,
            status: None,
            code: None,
            message,
            param: None,
            request_id: None,
        }
    }
}

fn kind_for(status: u16) -> ErrorKind {
    match status {
        400 => ErrorKind::BadRequest,
        401 => ErrorKind::Authentication,
        403 => ErrorKind::PermissionDenied,
        404 => ErrorKind::NotFound,
        409 => ErrorKind::Conflict,
        422 => ErrorKind::UnprocessableEntity,
        429 => ErrorKind::RateLimit,
        s if s >= 500 => ErrorKind::InternalServer,
        _ => ErrorKind::Api,
    }
}

/// Retry 408, 429, 5xx, and a 409 that says the same request is still running. Never retry other 4xx replies.
fn retryable(status: u16, code: &str) -> bool {
    status == 408
        || status == 429
        || status >= 500
        || (status == 409 && code == "request_in_progress")
}

/// Retry-After seconds when the API sends it, else 0.5 s doubling to 8 s, with a random part so clients spread out.
fn delay(attempt: u32, headers: Option<&HeaderMap>) -> Duration {
    let after = headers
        .and_then(|h| h.get("retry-after"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0);
    let base_ms = match after {
        Some(s) => s.min(60.0) * 1000.0,
        None => (500.0 * 2f64.powi(attempt.min(10) as i32)).min(8000.0),
    };
    // uuid v4 is already a dependency, so it supplies the random part.
    let jitter_ms = (uuid::Uuid::new_v4().as_u128() % 250) as f64;
    Duration::from_secs_f64((base_ms + jitter_ms) / 1000.0)
}

/// Percent-encodes one path segment, like encodeURIComponent.
pub(crate) fn encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Generated params and bodies hold only strings, numbers, booleans, and lists, so they always serialize.
pub(crate) fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("generated types always serialize to JSON")
}

/// The Frontmost AI client. `Client::new()` reads FRONTMOST_API_KEY. Cloning it is cheap.
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    max_retries: u32,
    timeout: Duration,
}

impl Client {
    /// A client from FRONTMOST_API_KEY and FRONTMOST_BASE_URL.
    pub fn new() -> Result<Self, Error> {
        Self::with_options(ClientOptions::default())
    }

    pub fn with_options(options: ClientOptions) -> Result<Self, Error> {
        let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let api_key = options.api_key.or_else(|| env("FRONTMOST_API_KEY")).ok_or_else(|| {
            Error::new(
                ErrorKind::Config,
                "No API key. Set FRONTMOST_API_KEY, or pass api_key. Create a key on the Team page: https://app.frontmost.ai/team".into(),
            )
        })?;
        let base_url = options
            .base_url
            .or_else(|| env("FRONTMOST_BASE_URL"))
            .unwrap_or_else(|| DEFAULT_BASE_URL.into())
            .trim_end_matches('/')
            .to_string();
        let http = reqwest::Client::builder().build().map_err(|e| {
            Error::new(
                ErrorKind::Config,
                format!("Could not start the HTTP client: {e}"),
            )
        })?;
        Ok(Client {
            http,
            api_key,
            base_url,
            max_retries: options.max_retries.unwrap_or(2),
            timeout: options.timeout.unwrap_or(Duration::from_secs(60)),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// One call with retries. `query` is a JSON object; null fields are left out. A 204 reply decodes as `()`.
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: Option<Value>,
        body: Option<Value>,
        options: Option<RequestOptions>,
    ) -> Result<T, Error> {
        let (_, value) = self
            .send(method.clone(), path, query, body, options)
            .await?;
        decode(value, &method, path)
    }

    /// Sends the call, and while the reply is a 202, waits `retry_after` seconds and sends its `next` call.
    /// Returns the final reply. Each follow-up call gets its own idempotency key, because its body is different.
    pub async fn wait<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        options: Option<RequestOptions>,
    ) -> Result<T, Error> {
        let deadline = tokio::time::Instant::now() + WAIT_LIMIT;
        let follow = RequestOptions {
            idempotency_key: None,
            ..options.clone().unwrap_or_default()
        };
        let (mut status, mut reply) = self.send(method.clone(), path, None, body, options).await?;
        while status == 202 {
            let next = &reply["next"];
            let (next_method, next_path, next_body) = (
                next["method"].as_str().unwrap_or("POST").to_string(),
                self.relative(next["path"].as_str().unwrap_or_default()),
                next["body"].clone(),
            );
            let after =
                Duration::from_secs_f64(reply["retry_after"].as_f64().unwrap_or(1.0).max(0.0));
            if tokio::time::Instant::now() + after > deadline {
                return Err(Error::new(
                    ErrorKind::Timeout,
                    format!(
                        "{} is still running after {} minutes. Send {next_method} {} with {next_body} later to continue.",
                        reply["id"].as_str().unwrap_or("The call"),
                        WAIT_LIMIT.as_secs() / 60,
                        next["path"].as_str().unwrap_or_default(),
                    ),
                ));
            }
            tokio::time::sleep(after).await;
            let m = Method::from_bytes(next_method.as_bytes()).unwrap_or(Method::POST);
            (status, reply) = self
                .send(m, &next_path, None, Some(next_body), Some(follow.clone()))
                .await?;
        }
        decode(reply, &method, path)
    }

    /// `next.path` in a reply starts at the site root, such as /api/v1/projects. Requests start after the base URL.
    fn relative(&self, path: &str) -> String {
        let base = Url::parse(&self.base_url)
            .map(|u| u.path().trim_end_matches('/').to_string())
            .unwrap_or_default();
        match path.strip_prefix(&base) {
            Some(rest) if rest.starts_with('/') => rest.to_string(),
            _ => path.to_string(),
        }
    }

    /// One call with retries. Returns the status and the JSON of a success reply, or `null` for no body.
    async fn send(
        &self,
        method: Method,
        path: &str,
        query: Option<Value>,
        body: Option<Value>,
        options: Option<RequestOptions>,
    ) -> Result<(u16, Value), Error> {
        let o = options.unwrap_or_default();
        let max_retries = o.max_retries.unwrap_or(self.max_retries);
        let timeout = o.timeout.unwrap_or(self.timeout);
        let idempotency_key = (method == Method::POST).then(|| {
            o.idempotency_key
                .unwrap_or_else(|| format!("sdk_{}", uuid::Uuid::new_v4()))
        });

        let mut url = Url::parse(&format!("{}{}", self.base_url, path)).map_err(|e| {
            Error::new(
                ErrorKind::Config,
                format!("Bad URL {}{}: {e}", self.base_url, path),
            )
        })?;
        if let Some(Value::Object(map)) = &query {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in map {
                match v {
                    Value::Null => {}
                    Value::String(s) => {
                        pairs.append_pair(k, s);
                    }
                    other => {
                        pairs.append_pair(k, &other.to_string());
                    }
                }
            }
        }
        let body = body.map(|b| serde_json::to_vec(&b).expect("a JSON value always serializes"));

        let mut attempt = 0;
        loop {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .timeout(timeout)
                .header("accept", "application/json")
                .header("authorization", format!("Bearer {}", self.api_key))
                .header("x-frontmost-lang", "rust")
                .header("x-frontmost-package-version", VERSION)
                .header("x-frontmost-retry-count", attempt.to_string());
            if let Some(key) = &idempotency_key {
                req = req.header("idempotency-key", key);
            }
            if let Some(b) = &body {
                req = req
                    .header("content-type", "application/json")
                    .body(b.clone());
            }

            let res = match req.send().await {
                Ok(res) => res,
                Err(e) => {
                    if attempt < max_retries {
                        tokio::time::sleep(delay(attempt, None)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(if e.is_timeout() {
                        Error::new(
                            ErrorKind::Timeout,
                            format!(
                                "No reply in {} ms from {method} {path}.",
                                timeout.as_millis()
                            ),
                        )
                    } else {
                        Error::new(ErrorKind::Connection, format!("Could not reach {url}: {e}"))
                    });
                }
            };

            let status = res.status().as_u16();
            let headers = res.headers().clone();
            let bytes = res.bytes().await.map_err(|e| {
                Error::new(
                    ErrorKind::Connection,
                    format!("Could not read the reply from {method} {path}: {e}"),
                )
            })?;

            if (200..300).contains(&status) {
                let value = if status == 204 || bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).map_err(|e| {
                        Error::new(
                            ErrorKind::Json,
                            format!("{method} {path} sent a reply that is not JSON: {e}"),
                        )
                    })?
                };
                return Ok((status, value));
            }

            let reply: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let field = |name: &str| reply["error"][name].as_str().map(String::from);
            let code = field("code").unwrap_or_else(|| "unknown_error".into());
            if retryable(status, &code) && attempt < max_retries {
                tokio::time::sleep(delay(attempt, Some(&headers))).await;
                attempt += 1;
                continue;
            }
            let header_id = headers
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            return Err(Error {
                kind: kind_for(status),
                status: Some(status),
                code: Some(code),
                message: field("message")
                    .unwrap_or_else(|| format!("{method} {path} failed with {status}.")),
                param: field("param"),
                request_id: field("request_id").or(header_id),
            });
        }
    }
}

fn decode<T: DeserializeOwned>(value: Value, method: &Method, path: &str) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|e| {
        Error::new(
            ErrorKind::Json,
            format!("{method} {path} sent a reply this SDK cannot read: {e}"),
        )
    })
}

/// One page of a list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListPage<T> {
    pub object: String,
    pub data: Vec<T>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

/// Every item of a list, page by page. `.stream()` yields items; `.collect_all()` returns them all.
/// `L` is the full reply of one page, which can carry more than the items, such as the `scope` of a rivals list.
#[derive(Debug, Clone)]
pub struct Page<T, L = ListPage<T>> {
    client: Client,
    path: String,
    query: Value,
    options: Option<RequestOptions>,
    item: PhantomData<fn() -> (T, L)>,
}

impl<T: DeserializeOwned, L: DeserializeOwned> Page<T, L> {
    pub(crate) fn new(
        client: &Client,
        path: String,
        query: Value,
        options: Option<RequestOptions>,
    ) -> Self {
        Page {
            client: client.clone(),
            path,
            query,
            options,
            item: PhantomData,
        }
    }

    /// One page. Pass the `next_cursor` of the page before.
    pub async fn page(&self, cursor: Option<&str>) -> Result<L, Error> {
        self.fetch(cursor).await
    }

    async fn fetch<P: DeserializeOwned>(&self, cursor: Option<&str>) -> Result<P, Error> {
        let mut query = match &self.query {
            Value::Object(map) => map.clone(),
            _ => serde_json::Map::new(),
        };
        if let Some(c) = cursor {
            query.insert("cursor".into(), c.into());
        }
        self.client
            .request(
                Method::GET,
                &self.path,
                Some(Value::Object(query)),
                None,
                self.options.clone(),
            )
            .await
    }

    /// Every item across pages, fetched one page at a time as the stream is read.
    pub fn stream(self) -> impl Stream<Item = Result<T, Error>> {
        // State: Some(cursor) while a page is left to read. Some(None) is the first page.
        stream::try_unfold((self, Some(None::<String>)), |(list, next)| async move {
            let Some(cursor) = next else { return Ok(None) };
            let p: ListPage<T> = list.fetch(cursor.as_deref()).await?;
            let next = if p.has_more {
                p.next_cursor.map(Some)
            } else {
                None
            };
            Ok(Some((
                stream::iter(p.data.into_iter().map(Ok)),
                (list, next),
            )))
        })
        .try_flatten()
    }

    /// Every item of every page, in order.
    pub async fn collect_all(self) -> Result<Vec<T>, Error> {
        self.stream().try_collect().await
    }
}

/// "22% · 8 of 36" from a rate with its counts. A rate with no answers is "No answers".
pub fn format_rate(rate: Option<&crate::Rate>) -> String {
    match rate {
        Some(crate::Rate {
            value: Some(v),
            numerator,
            denominator,
            ..
        }) if *denominator > 0 => {
            format!("{}% · {numerator} of {denominator}", (v * 100.0).round())
        }
        _ => "No answers".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_rate_shows_the_rate_with_its_counts() {
        let rate = crate::Rate {
            value: Some(8.0 / 36.0),
            numerator: 8,
            denominator: 36,
            previous: None,
        };
        assert_eq!(format_rate(Some(&rate)), "22% · 8 of 36");
        assert_eq!(format_rate(None), "No answers");
    }
}
