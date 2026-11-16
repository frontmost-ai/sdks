# The eleven cases in conformance/README.md. conformance/run.mjs sets FRONTMOST_BASE_URL to the mock.
import asyncio
import os
import re
from typing import Any

import httpx
import pytest

from frontmost import (
    APIConnectionError,
    APIConnectionTimeoutError,
    AsyncFrontmost,
    AuthenticationError,
    Frontmost,
    InternalServerError,
    NotFoundError,
    format_rate,
)

base = os.environ["FRONTMOST_BASE_URL"]
root = re.sub(r"/v1$", "", base)
client = Frontmost()


def log() -> list[Any]:
    seen: list[Any] = httpx.get(f"{root}/__log").json()
    return seen


@pytest.fixture(autouse=True)
def reset() -> None:
    httpx.post(f"{root}/__reset")


def test_1_retries_a_429_and_sends_the_retry_count() -> None:
    w = client.workspace.get()
    assert w["name"] == "Papaya"
    seen = log()
    assert [r["headers"]["x-frontmost-retry-count"] for r in seen] == ["0", "1"]
    for r in seen:
        assert r["headers"]["authorization"] == "Bearer fmk_test"
        assert r["headers"]["x-frontmost-lang"] == "python"
        assert r["headers"]["x-frontmost-package-version"]


def test_2_reads_every_page_in_order() -> None:
    assert [q["id"] for q in client.questions.list("1")] == ["1", "2", "3"]
    assert re.search(r"cursor=p2", log()[1]["query"])


def test_3_stops_after_2_retries_of_a_500() -> None:
    with pytest.raises(InternalServerError) as e:
        client.projects.get("2")
    assert e.value.code == "internal_error" and e.value.request_id == "req_500"
    assert len(log()) == 3


def test_4_never_retries_a_404_and_keeps_the_api_message() -> None:
    with pytest.raises(NotFoundError) as e:
        client.projects.get("3")
    assert e.value.status == 404 and e.value.code == "not_found" and e.value.request_id == "req_404"
    assert e.value.message == "No project with this ID in this workspace. List projects at /api/v1/projects."
    assert len(log()) == 1


def test_5_sends_one_idempotency_key_on_both_attempts() -> None:
    out = client.questions.create("1", {"questions": [{"text": "Which bank is best for students?"}]})
    assert out["data"][0]["text"] == "Which bank is best for students?"
    keys = [r["headers"]["idempotency-key"] for r in log()]
    assert len(keys) == 2
    assert keys[0] and keys[0] == keys[1]


def test_6_returns_nothing_for_a_204() -> None:
    client.profiles.delete("4")  # A parse error would raise here.


def test_7_never_retries_a_401() -> None:
    with pytest.raises(AuthenticationError) as e:
        Frontmost("fmk_wrong").workspace.get()
    assert e.value.code == "invalid_key"
    assert len(log()) == 1


def test_8_retries_a_409_request_in_progress_with_the_same_key() -> None:
    p = client.profiles.create("1", {"name": "Agency owner", "who": "Runs a small agency"})
    assert p["name"] == "Agency owner"
    keys = [r["headers"]["idempotency-key"] for r in log()]
    assert len(keys) == 2
    assert keys[0] and keys[0] == keys[1]


def test_9_retries_a_timeout_then_raises_the_timeout_error() -> None:
    with pytest.raises(APIConnectionTimeoutError):
        Frontmost(timeout=0.1, max_retries=1).projects.get("6")
    assert len(log()) == 2


def test_10_raises_the_connection_error_when_no_server_answers() -> None:
    with pytest.raises(APIConnectionError) as e:
        Frontmost(base_url="http://127.0.0.1:9/v1", max_retries=0).workspace.get()
    assert not isinstance(e.value, APIConnectionTimeoutError)


def test_11_create_and_wait_follows_the_202_to_the_project() -> None:
    p = client.projects.create_and_wait({"domain": "papaya.example"})
    assert p["id"] == "12"
    seen = log()
    assert len(seen) == 2
    assert seen[1]["body"] == {"setup_id": "12"}
    first, second = (r["headers"]["idempotency-key"] for r in seen)
    assert first and second and first != second


def test_async_2_reads_every_page_in_order() -> None:
    async def run() -> list[str]:
        async with AsyncFrontmost() as c:
            return [q["id"] async for q in c.questions.list("1")]

    assert asyncio.run(run()) == ["1", "2", "3"]
    assert re.search(r"cursor=p2", log()[1]["query"])


def test_async_5_sends_one_idempotency_key_on_both_attempts() -> None:
    async def run() -> Any:
        async with AsyncFrontmost() as c:
            return await c.questions.create("1", {"questions": [{"text": "Which bank is best for students?"}]})

    out = asyncio.run(run())
    assert out["data"][0]["text"] == "Which bank is best for students?"
    keys = [r["headers"]["idempotency-key"] for r in log()]
    assert len(keys) == 2
    assert keys[0] and keys[0] == keys[1]


def test_async_11_create_and_wait_follows_the_202_to_the_project() -> None:
    async def run() -> Any:
        async with AsyncFrontmost() as c:
            return await c.projects.create_and_wait({"domain": "papaya.example"})

    assert asyncio.run(run())["id"] == "12"
    assert len(log()) == 2


def test_12_keeps_the_fields_that_an_open_reply_does_not_name() -> None:
    scan = client.scans.get("12", "latest")
    assert scan["kpis"] == {"visibility": 22}


def test_format_rate_shows_the_rate_with_its_counts() -> None:
    assert format_rate({"value": 8 / 36, "numerator": 8, "denominator": 36, "previous": None}) == "22% · 8 of 36"
    assert format_rate({"value": None, "numerator": 0, "denominator": 0, "previous": None}) == "No answers"
