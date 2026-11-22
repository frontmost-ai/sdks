// Hand-written runtime. The generator never writes this file. It holds what every route shares:
// the key, retries, timeouts, errors, idempotency keys, and cursor pages.

export const VERSION = "0.4.2";

export type ClientOptions = {
  /** Default: FRONTMOST_API_KEY. */
  apiKey?: string;
  /** Default: FRONTMOST_BASE_URL, then https://app.frontmost.ai/api/v1. */
  baseURL?: string;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Milliseconds for one attempt. Default 60000. */
  timeout?: number;
  fetch?: typeof fetch;
  defaultHeaders?: Record<string, string>;
};

export type RequestOptions = {
  maxRetries?: number;
  timeout?: number;
  /** Default for a POST: a new random key, sent again on each retry of that call. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export type ListPage<T> = { object: "list"; data: T[]; has_more: boolean; next_cursor: string | null };

/** The 202 reply of a call that is still working: wait `retry_after` seconds, then send `next`. */
type Accepted = { id: string; retry_after: number; next: { method: string; path: string; body: unknown } };

/** The longest time a `...AndWait` method waits before it stops with an error. */
const WAIT_LIMIT_MS = 10 * 60_000;

export class FrontmostError extends Error {
  override name = "FrontmostError";
}

/** An error reply from the API. `message` is the API's own text, which says what to do next. */
export class APIError extends FrontmostError {
  override name = "APIError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null,
    readonly requestId: string | null,
    readonly headers: Headers,
  ) {
    super(message);
  }
}
export class BadRequestError extends APIError { override name = "BadRequestError"; }
export class AuthenticationError extends APIError { override name = "AuthenticationError"; }
export class PermissionDeniedError extends APIError { override name = "PermissionDeniedError"; }
export class NotFoundError extends APIError { override name = "NotFoundError"; }
export class ConflictError extends APIError { override name = "ConflictError"; }
export class UnprocessableEntityError extends APIError { override name = "UnprocessableEntityError"; }
export class RateLimitError extends APIError { override name = "RateLimitError"; }
export class InternalServerError extends APIError { override name = "InternalServerError"; }
export class APIConnectionError extends FrontmostError { override name = "APIConnectionError"; }
export class APIConnectionTimeoutError extends APIConnectionError { override name = "APIConnectionTimeoutError"; }

const ERRORS: Record<number, typeof APIError> = {
  400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError, 404: NotFoundError,
  409: ConflictError, 422: UnprocessableEntityError, 429: RateLimitError,
};

/** Retry 408, 429, 5xx, and a 409 that says the same request is still running. Never retry other 4xx replies. */
const retryable = (status: number, code: string) => status === 408 || status === 429 || status >= 500 || (status === 409 && code === "request_in_progress");

/** Retry-After seconds when the API sends it, else 0.5 s doubling to 8 s, with a random part so clients spread out. */
function delayMs(attempt: number, headers?: Headers) {
  const after = Number(headers?.get("retry-after"));
  const base = Number.isFinite(after) && after >= 0 && headers?.has("retry-after") ? Math.min(after, 60) * 1000 : Math.min(500 * 2 ** attempt, 8000);
  return base + Math.random() * 250;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (name: string) => (typeof process !== "undefined" ? process.env?.[name] : undefined);

function queryString(query?: Record<string, unknown>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Every item of a list, page by page. `for await (const x of page)` reads all pages.
 * `L` is the full reply of one page, which can carry more than the items, such as the `scope` of a rivals list.
 */
export class Page<T, L extends ListPage<T> = ListPage<T>> implements AsyncIterable<T> {
  constructor(private readonly fetchPage: (cursor?: string) => Promise<L>) {}

  /** One page. Pass the `next_cursor` of the page before. */
  page(cursor?: string): Promise<L> {
    return this.fetchPage(cursor);
  }

  async *[Symbol.asyncIterator]() {
    let cursor: string | undefined;
    do {
      const p = await this.fetchPage(cursor);
      yield* p.data;
      cursor = p.has_more && p.next_cursor ? p.next_cursor : undefined;
    } while (cursor);
  }

  async toArray() {
    const all: T[] = [];
    for await (const x of this) all.push(x);
    return all;
  }
}

type RequestInit = { query?: Record<string, unknown>; body?: unknown; options?: RequestOptions };

export class Core {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("FRONTMOST_API_KEY");
    if (!apiKey) throw new FrontmostError("No API key. Set FRONTMOST_API_KEY, or pass apiKey. Create a key on the Team page: https://app.frontmost.ai/team");
    this.#apiKey = apiKey;
    this.baseURL = (options.baseURL ?? env("FRONTMOST_BASE_URL") ?? "https://app.frontmost.ai/api/v1").replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeout = options.timeout ?? 60_000;
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.defaultHeaders ?? {};
  }

  async request<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
    return (await this.send<T>(method, path, init)).data;
  }

  /**
   * Sends the call, and while the reply is a 202, waits `retry_after` seconds and sends its `next` call.
   * Returns the final reply. Each follow-up call gets its own idempotency key, because its body is different.
   */
  async wait<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    let reply = await this.send<unknown>(method, path, init);
    while (reply.status === 202) {
      const a = reply.data as Accepted;
      if (Date.now() + a.retry_after * 1000 > deadline) {
        throw new FrontmostError(`${a.id} is still running after ${WAIT_LIMIT_MS / 60_000} minutes. Send ${a.next.method} ${a.next.path} with ${JSON.stringify(a.next.body)} later to continue.`);
      }
      await sleep(a.retry_after * 1000);
      const { idempotencyKey: _, ...options } = init.options ?? {};
      reply = await this.send<unknown>(a.next.method, this.#relative(a.next.path), { body: a.next.body, options });
    }
    return reply.data as T;
  }

  /** `next.path` in a reply starts at the site root, such as /api/v1/projects. Requests start after the base URL. */
  #relative(path: string) {
    const base = new URL(this.baseURL).pathname.replace(/\/$/, "");
    return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
  }

  private async send<T>(method: string, path: string, init: RequestInit): Promise<{ status: number; data: T }> {
    const o = init.options ?? {};
    const maxRetries = o.maxRetries ?? this.maxRetries;
    const timeout = o.timeout ?? this.timeout;
    const idempotencyKey = method === "POST" ? (o.idempotencyKey ?? `sdk_${crypto.randomUUID()}`) : undefined;
    const url = `${this.baseURL}${path}${queryString(init.query)}`;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${this.#apiKey}`,
        "x-frontmost-lang": "typescript",
        "x-frontmost-package-version": VERSION,
        "x-frontmost-retry-count": String(attempt),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...this.#headers,
        ...o.headers,
      };
      const timer = AbortSignal.timeout(timeout);
      const signal = o.signal ? AbortSignal.any([o.signal, timer]) : timer;
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        const timedOut = timer.aborted;
        if (attempt < maxRetries) {
          await sleep(delayMs(attempt));
          continue;
        }
        throw timedOut ? new APIConnectionTimeoutError(`No reply in ${timeout} ms from ${method} ${path}.`) : new APIConnectionError(`Could not reach ${url}: ${(e as Error).message}`);
      }

      if (res.ok) {
        const text = res.status === 204 ? "" : await res.text();
        return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
      }

      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; param?: string | null; request_id?: string } } | null;
      const e = body?.error ?? {};
      const code = e.code ?? "unknown_error";
      if (retryable(res.status, code) && attempt < maxRetries) {
        await sleep(delayMs(attempt, res.headers));
        continue;
      }
      const Kind = ERRORS[res.status] ?? (res.status >= 500 ? InternalServerError : APIError);
      throw new Kind(res.status, code, e.message ?? `${method} ${path} failed with ${res.status}.`, e.param ?? null, e.request_id ?? res.headers.get("x-request-id"), res.headers);
    }
  }

  list<T, L extends ListPage<T>>(path: string, query: Record<string, unknown> | undefined, options: RequestOptions | undefined) {
    return new Page<T, L>((cursor) => this.request<L>("GET", path, { query: { ...query, cursor }, options }));
  }
}

/** "22% · 8 of 36" from a rate with its counts. A rate with no answers is "No answers". */
export function formatRate(rate: { value: number | null; numerator: number; denominator: number } | null) {
  if (!rate || rate.value === null || rate.denominator === 0) return "No answers";
  return `${Math.round(rate.value * 100)}% · ${rate.numerator} of ${rate.denominator}`;
}
