# Hand-written runtime. The generator never writes this file. It holds what every route shares:
# the key, retries, timeouts, errors, idempotency keys, and cursor pages.
# The sync and async clients share every decision. Only the send and the sleep differ.

import asyncio
import math
import os
import random
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from typing import Any, Generic, Literal, Optional, TypeVar, Union, cast

import httpx
from typing_extensions import TypedDict

VERSION = "0.2.0"
DEFAULT_BASE_URL = "https://app.frontmost.ai/api/v1"
# The longest time an `..._and_wait` method waits, in seconds, before it stops with an error.
WAIT_LIMIT = 600.0

T = TypeVar("T")
L = TypeVar("L")
D = TypeVar("D")


class RequestOptions(TypedDict, total=False):
    """Per-call settings. Pass them as keyword arguments to any method."""

    max_retries: int
    # Seconds for one attempt.
    timeout: float
    # Default for a POST: a new random key, sent again on each retry of that call.
    idempotency_key: str
    extra_headers: Mapping[str, str]


class ListPage(TypedDict, Generic[T]):
    object: Literal["list"]
    data: list[T]
    has_more: bool
    next_cursor: Optional[str]


class FrontmostError(Exception):
    pass


class APIError(FrontmostError):
    """An error reply from the API. `message` is the API's own text, which says what to do next."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        param: Optional[str],
        request_id: Optional[str],
        headers: httpx.Headers,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.param = param
        self.request_id = request_id
        self.headers = headers


class BadRequestError(APIError):
    pass


class AuthenticationError(APIError):
    pass


class PermissionDeniedError(APIError):
    pass


class NotFoundError(APIError):
    pass


class ConflictError(APIError):
    pass


class UnprocessableEntityError(APIError):
    pass


class RateLimitError(APIError):
    pass


class InternalServerError(APIError):
    pass


class APIConnectionError(FrontmostError):
    pass


class APIConnectionTimeoutError(APIConnectionError):
    pass


_ERRORS: dict[int, type[APIError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def _retryable(status: int, code: str) -> bool:
    """Retry 408, 429, 5xx, and a 409 that says the same request is still running. Never retry other 4xx replies."""
    return status == 408 or status == 429 or status >= 500 or (status == 409 and code == "request_in_progress")


def _delay(attempt: int, headers: Optional[httpx.Headers] = None) -> float:
    """Retry-After seconds when sent, else 0.5 s doubling to 8 s, plus a random part so clients spread out."""
    try:
        after = float(headers["retry-after"]) if headers is not None else math.nan
    except (KeyError, ValueError):
        after = math.nan
    base = min(after, 60.0) if math.isfinite(after) and after >= 0 else min(0.5 * 2**attempt, 8.0)
    return base + random.random() * 0.25


def _text(value: Any, default: D) -> Union[str, D]:
    """The API's own text unchanged, or the default when the field is missing or null."""
    return default if value is None else str(value)


def _api_error(response: httpx.Response, method: str, path: str) -> APIError:
    try:
        body = response.json()
    except ValueError:
        body = None
    e = body.get("error") if isinstance(body, dict) else None
    e = e if isinstance(e, dict) else {}
    status = response.status_code
    kind = _ERRORS.get(status) or (InternalServerError if status >= 500 else APIError)
    return kind(
        status,
        _text(e.get("code"), "unknown_error"),
        _text(e.get("message"), f"{method} {path} failed with {status}."),
        _text(e.get("param"), None),
        _text(e.get("request_id"), response.headers.get("x-request-id")),
        response.headers,
    )


def _parse(response: httpx.Response) -> Any:
    if response.status_code == 204 or not response.content:
        return None
    return response.json()


class _Wait:
    """The rules for following a 202 reply: wait `retry_after` seconds, then send its `next` call."""

    def __init__(self, base_url: str, options: RequestOptions) -> None:
        self.deadline = time.monotonic() + WAIT_LIMIT
        self.base_path = httpx.URL(base_url).path.rstrip("/")
        # Each follow-up call gets its own idempotency key, because its body is different.
        self.options: RequestOptions = {**options}
        self.options.pop("idempotency_key", None)

    def next(self, reply: Any) -> tuple[float, str, str, Any]:
        """Seconds to wait, then the method, path, and body of the next call. Raises when the wait is too long."""
        after, nxt = float(reply["retry_after"]), reply["next"]
        if time.monotonic() + after > self.deadline:
            raise FrontmostError(
                f"{reply['id']} is still running after {WAIT_LIMIT / 60:.0f} minutes. "
                f"Send {nxt['method']} {nxt['path']} with {nxt['body']} later to continue."
            )
        path = str(nxt["path"])
        # `next.path` starts at the site root, such as /api/v1/projects. Requests start after the base URL.
        if path.startswith(f"{self.base_path}/"):
            path = path[len(self.base_path) :]
        return after, str(nxt["method"]), path, nxt["body"]


class _Base:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        default_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        key = api_key or os.environ.get("FRONTMOST_API_KEY")
        if not key:
            raise FrontmostError(
                "No API key. Set FRONTMOST_API_KEY, or pass api_key. Create a key on the Team page: https://app.frontmost.ai/team"
            )
        self._api_key = key
        self.base_url = (base_url or os.environ.get("FRONTMOST_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.max_retries = max_retries
        self.timeout = timeout
        self._headers = dict(default_headers or {})

    def _prepare(self, method: str, options: RequestOptions) -> "_Call":
        key = (options.get("idempotency_key") or f"sdk_{uuid.uuid4()}") if method == "POST" else None
        return _Call(options.get("max_retries", self.max_retries), options.get("timeout", self.timeout), key)

    def _send_args(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, object]],
        body: Optional[Mapping[str, object]],
        call: "_Call",
        attempt: int,
        options: RequestOptions,
    ) -> dict[str, Any]:
        headers = {
            "accept": "application/json",
            "authorization": f"Bearer {self._api_key}",
            "x-frontmost-lang": "python",
            "x-frontmost-package-version": VERSION,
            "x-frontmost-retry-count": str(attempt),
            **({"content-type": "application/json"} if body is not None else {}),
            **({"idempotency-key": call.idempotency_key} if call.idempotency_key else {}),
            **self._headers,
            **options.get("extra_headers", {}),
        }
        params = {k: v for k, v in (query or {}).items() if v is not None}
        return {
            "method": method,
            "url": f"{self.base_url}{path}",
            "params": params,
            "json": body,
            "headers": headers,
            "timeout": call.timeout,
        }

    def _retry_delay(
        self, failure: Union[httpx.Response, httpx.TransportError], call: "_Call", attempt: int, method: str, path: str
    ) -> float:
        """Seconds to wait before the next attempt. Raises the error when the call must stop."""
        if isinstance(failure, httpx.Response):
            error = _api_error(failure, method, path)
            if attempt < call.max_retries and _retryable(error.status, error.code):
                return _delay(attempt, failure.headers)
            raise error
        if attempt < call.max_retries:
            return _delay(attempt)
        if isinstance(failure, httpx.TimeoutException):
            raise APIConnectionTimeoutError(f"No reply in {call.timeout} s from {method} {path}.") from failure
        raise APIConnectionError(f"Could not reach {self.base_url}{path}: {failure}") from failure


class _Call:
    def __init__(self, max_retries: int, timeout: float, idempotency_key: Optional[str]) -> None:
        self.max_retries = max_retries
        self.timeout = timeout
        self.idempotency_key = idempotency_key


class SyncPage(Generic[T, L]):
    """Every item of a list, page by page. `for x in page` reads all pages.

    `L` is the full reply of one page, which can carry more than the items, such as the `scope` of a rivals list.
    """

    def __init__(self, fetch: Callable[[Optional[str]], L]) -> None:
        self._fetch = fetch

    def page(self, cursor: Optional[str] = None) -> L:
        """One page. Pass the `next_cursor` of the page before."""
        return self._fetch(cursor)

    def __iter__(self) -> Iterator[T]:
        cursor: Optional[str] = None
        while True:
            p = cast(ListPage[T], self._fetch(cursor))
            yield from p["data"]
            cursor = p["next_cursor"] if p["has_more"] else None
            if not cursor:
                return

    def to_list(self) -> list[T]:
        return list(self)


class AsyncPage(Generic[T, L]):
    """Every item of a list, page by page. `async for x in page` reads all pages.

    `L` is the full reply of one page, which can carry more than the items, such as the `scope` of a rivals list.
    """

    def __init__(self, fetch: Callable[[Optional[str]], Awaitable[L]]) -> None:
        self._fetch = fetch

    async def page(self, cursor: Optional[str] = None) -> L:
        """One page. Pass the `next_cursor` of the page before."""
        return await self._fetch(cursor)

    async def __aiter__(self) -> AsyncIterator[T]:
        cursor: Optional[str] = None
        while True:
            p = cast(ListPage[T], await self._fetch(cursor))
            for x in p["data"]:
                yield x
            cursor = p["next_cursor"] if p["has_more"] else None
            if not cursor:
                return

    async def to_list(self) -> list[T]:
        return [x async for x in self]


class SyncCore(_Base):
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        default_headers: Optional[Mapping[str, str]] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        super().__init__(
            api_key, base_url=base_url, max_retries=max_retries, timeout=timeout, default_headers=default_headers
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, object]] = None,
        body: Optional[Mapping[str, object]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Any:
        return self._send(method, path, query, body, options or {})[1]

    def wait(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, object]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Any:
        """Sends the call, and while the reply is a 202, waits and sends its `next` call. Returns the final reply."""
        rules = _Wait(self.base_url, options or {})
        status, reply = self._send(method, path, None, body, options or {})
        while status == 202:
            after, method, path, body = rules.next(reply)
            time.sleep(after)
            status, reply = self._send(method, path, None, body, rules.options)
        return reply

    def _send(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, object]],
        body: Optional[Mapping[str, object]],
        options: RequestOptions,
    ) -> tuple[int, Any]:
        call = self._prepare(method, options)
        attempt = 0
        while True:
            failure: Union[httpx.Response, httpx.TransportError]
            try:
                failure = self._http.request(**self._send_args(method, path, query, body, call, attempt, options))
                if failure.is_success:
                    return failure.status_code, _parse(failure)
            except httpx.TransportError as e:
                failure = e
            time.sleep(self._retry_delay(failure, call, attempt, method, path))
            attempt += 1

    def list(self, path: str, query: Mapping[str, object], options: RequestOptions) -> SyncPage[Any, Any]:
        return SyncPage(lambda cursor: self.request("GET", path, query={**query, "cursor": cursor}, options=options))

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self: "S") -> "S":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncCore(_Base):
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        default_headers: Optional[Mapping[str, str]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        super().__init__(
            api_key, base_url=base_url, max_retries=max_retries, timeout=timeout, default_headers=default_headers
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.AsyncClient()

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, object]] = None,
        body: Optional[Mapping[str, object]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Any:
        return (await self._send(method, path, query, body, options or {}))[1]

    async def wait(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, object]] = None,
        options: Optional[RequestOptions] = None,
    ) -> Any:
        """Sends the call, and while the reply is a 202, waits and sends its `next` call. Returns the final reply."""
        rules = _Wait(self.base_url, options or {})
        status, reply = await self._send(method, path, None, body, options or {})
        while status == 202:
            after, method, path, body = rules.next(reply)
            await asyncio.sleep(after)
            status, reply = await self._send(method, path, None, body, rules.options)
        return reply

    async def _send(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, object]],
        body: Optional[Mapping[str, object]],
        options: RequestOptions,
    ) -> tuple[int, Any]:
        call = self._prepare(method, options)
        attempt = 0
        while True:
            failure: Union[httpx.Response, httpx.TransportError]
            try:
                failure = await self._http.request(**self._send_args(method, path, query, body, call, attempt, options))
                if failure.is_success:
                    return failure.status_code, _parse(failure)
            except httpx.TransportError as e:
                failure = e
            await asyncio.sleep(self._retry_delay(failure, call, attempt, method, path))
            attempt += 1

    def list(self, path: str, query: Mapping[str, object], options: RequestOptions) -> AsyncPage[Any, Any]:
        return AsyncPage(lambda cursor: self.request("GET", path, query={**query, "cursor": cursor}, options=options))

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self: "A") -> "A":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()


S = TypeVar("S", bound=SyncCore)
A = TypeVar("A", bound=AsyncCore)


class SyncResource:
    def __init__(self, core: SyncCore) -> None:
        self._core = core


class AsyncResource:
    def __init__(self, core: AsyncCore) -> None:
        self._core = core


def format_rate(rate: Optional[Mapping[str, Any]]) -> str:
    """ "22% · 8 of 36" from a rate with its counts. A rate with no answers is "No answers"."""
    if not rate or rate.get("value") is None or rate.get("denominator") == 0:
        return "No answers"
    return f"{math.floor(rate['value'] * 100 + 0.5)}% · {rate['numerator']} of {rate['denominator']}"
