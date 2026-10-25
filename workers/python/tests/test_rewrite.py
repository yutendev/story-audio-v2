"""T5.3 — provider interface + rewrite service (FAKE PROVIDER, hoàn toàn offline).

Kiểm: prompt inputs, output handling, lỗi network, cache key định danh,
classification retry (quota vs validation vs network), policy whitelist.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
from datetime import datetime, timedelta, timezone

import pytest

from story_audio import actions
from story_audio.exit_codes import ExitCode
from story_audio.providers import (
    AuthError,
    LLMClient,
    PROVIDER_POLICY,
    ProviderError,
    RateLimited,
    quota_not_before,
    resolve_providers,
)
from story_audio.rewrite import (
    build_prompt,
    cache_key,
    chunk_text,
    glossary_subset,
    load_cache,
    load_glossary,
    model_fingerprint,
    split_sentences,
    validate,
)

_NO_SLEEP = lambda _s: None  # noqa: E731 — backoff không thật trong test


class FakeProvider:
    """Provider test: script các đầu ra/exception theo lượt gọi; ghi prompt nhận vào."""

    name = "fake"

    def __init__(self, script):
        self._script = list(script)
        self.prompts: list[str] = []
        self.calls = 0

    def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        item = self._script.pop(0) if self._script else None
        if isinstance(item, Exception):
            raise item
        return item if isinstance(item, str) else "   "  # script cạn → trả rỗng


class EchoProvider:
    """Trả lại chính phần gốc (đúng ratio 1.0) — dùng cho flow rẻ nhánh vui."""

    name = "echo"

    def __init__(self):
        self.prompts: list[str] = []
        self.calls = 0

    def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        return _part(prompt)


class LeadinEcho(EchoProvider):
    """Luôn trả lời kèm lời dẫn AI — validate fail đúng lỗi 'lời dẫn AI' mọi attempt."""

    def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        return "Dưới đây là " + _part(prompt)


def _workdir(tmp_path: pathlib.Path) -> pathlib.Path:
    wd = tmp_path / "work"
    wd.mkdir(parents=True, exist_ok=True)
    return wd


def _seed_chapter(workdir, no: int, title: str, paragraphs: list[str]):
    d = workdir / "chapters" / f"{no:04d}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "normalized.txt").write_text(
        title + "\n\n" + "\n".join(paragraphs) + "\n", encoding="utf-8"
    )
    return d


def _events(capsys) -> list[dict]:
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def _part(prompt: str) -> str:
    """Phần bản gốc được nhét vào cuối prompt (sau dòng nhãn) — Echo/LeadinEcho lấy lại."""
    return prompt.rsplit("Đoạn bản gốc cần viết lại:\n", 1)[-1].strip()


# ---------- prompt / validate / cache key / subset / chunk ----------


def test_build_prompt_contains_rules_subset_context_part():
    p = build_prompt("Văn gốc", {"Nhiên Dạ": "Nhiên Khanh"}, "Hai. Ba. Bốn.")
    assert "biên tập viên người Việt" in p
    assert "Giữ nguyên toàn bộ tên riêng" in p
    assert "- Nhiên Dạ → Nhiên Khanh" in p  # subset in đúng cột phải
    assert "Hai. Ba. Bốn." in p  # ngữ cảnh prev_tail
    assert "Văn gốc" in p  # phần cần viết lại
    p2 = build_prompt("X", {}, "")
    assert "Ngữ cảnh" not in p2 and "Bảng thuật ngữ" not in p2


def test_validate_rules():
    # hợp lệ: length tương đương, không leadin, rỗng problems
    original = "Văn gốc một hai ba bốn năm sáu bảy tám chín mười."
    rewritten = "Văn gốc một hai ba bốn năm sáu bảy tám chín rồi."
    assert validate(original, rewritten, {}) == []
    assert validate(original, "   ", {}) == ["đầu ra rỗng"]
    # ratio vượt biên
    rew_long = "dài " * 40
    assert any("độ dài lệch" in p for p in validate(original, rew_long, {}))
    # lười leadin AI
    assert any("lời dẫn AI" in p for p in validate(original, "Dưới đây là bản viết lại: " + original, {}))
    # thiếu thuật ngữ (fixed không có trong output)
    assert any("thiếu thuật ngữ" in p for p in validate("Nhiên Dạ đi", "Nhiên Khanh đi", {"X": "Con Cưng"}))
    # ngoặc thoại lệch
    assert any("ngoặc thoại" in p for p in validate('"Chào." Lại.', "không ngoặc ở đây", {}))


def test_glossary_subset_only_hits():
    g = {"Nhiên": "Nhiên Khanh", "Lã Âm": "Cổ Oai"}
    assert glossary_subset("Lã Âm ra tay", g) == {"Lã Âm": "Cổ Oai"}
    assert glossary_subset("không nhấn tên nào", g) == {}


def test_cache_key_deterministic():
    k = cache_key("phần văn", {"N": "K"})
    assert len(k) == 32
    assert k == cache_key("phần văn", {"N": "K"})             # lập lại → cùng key
    assert isinstance(k, str)
    assert cache_key("phần khác", {"N": "K"}) != k
    assert cache_key("phần văn", {"N": "K2"}) != k
    assert cache_key("phần văn", {"N": "K"}, version="2") != k
    # subset là dict — sort_keys nên thứ tự chèn không đổi key
    assert cache_key("p", {"A": "1", "B": "2"}) == cache_key("p", {"B": "2", "A": "1"})
    # model/config vào key — đổi model → key đổi (T5.8)
    assert cache_key("phần văn", {"N": "K"}, model="m1") != cache_key("phần văn", {"N": "K"}, model="m2")
    assert cache_key("phần văn", {"N": "K"}, model="m1") == cache_key("phần văn", {"N": "K"}, model="m1")


def test_chunk_text_never_exceeds_limit_no_empty_in_order():
    # một đoạn khổng lồ (lẫn CJK, emoji, ngoặc thoại) — tách theo câu/khoảng trắng
    para = ("Đây là câu thứ nhất với dấu 您好 xen kẽ ở giữa. "
            + "Câu hai “có ngoặc thoại” chấm hết. "
            + ("nội dung tiếp theo không dứt câu " * 40)
            + "Câu chốt cùng. Mô tả dài nữa đây. Emoji 🀄 lẫn lộn.")
    chunks = chunk_text([para], max_chars=600)
    assert chunks and all(c.strip() for c in chunks)  # không chunk rỗng
    assert all(len(c) <= 600 for c in chunks)         # biên trên tuyệt đối
    # không mất nội dung Unicode + thứ tự điểm mốc tăng dần
    joined = "\n".join(chunks)
    pos = 0
    for marker in ("您", "“có ngoặc thoại”", "Câu chốt cùng", "🀄"):
        at = joined.find(marker, pos)
        assert at >= 0
        pos = at


def test_chunk_text_huge_paragraph_without_spaces_hard_cuts():
    chunks = chunk_text(["z" * 2500], max_chars=600)
    assert all(0 < len(c) <= 600 for c in chunks)     # biên trên, không chunk rỗng
    assert "".join(chunks) == "z" * 2500              # cắt cứng — không mất ký tự
    assert len(chunks) >= 4

def test_chunk_text_dialogue_not_cut_mid_quote():
    piece_a = "“Đây là lời thoại thứ nhất trong truyện, chấm hết.”"
    piece_b = "“Đây là lời thoại thứ hai cũng dài tương đối chấm.”"
    para = " ".join([piece_a, piece_b] * 8)  # > 600 ký tự → tách theo câu
    chunks = chunk_text([para], max_chars=600)
    assert len(chunks) >= 2
    for c in chunks:
        assert c.count("“") == c.count("”")  # ngoặc thoại cân trong từng chunk


def test_chunk_text_merges_small_and_keeps_order():
    # đoạn nhỏ gộp 1 chunk, phân cách "\n" (port behavior cũ)
    assert chunk_text(["A" * 100, "B" * 100, "C" * 100]) == [
        "A" * 100 + "\n" + "B" * 100 + "\n" + "C" * 100
    ]
    # vượt biên → tách nhưng thứ tự A → B → C giữ nguyên, không chunk rỗng
    chunks = chunk_text(["A" * 800, "B" * 800, "C" * 800], max_chars=1500)
    assert chunks == ["A" * 800, "B" * 800, "C" * 800]


def test_chunk_text_configured_bound_in_stage(tmp_path, capsys):
    # mỗi cấu hình có workdir riêng — tránh cache trùng lấn cấn giữa các lần chạy
    wd300 = _workdir(tmp_path)
    _seed_chapter(wd300, 12, "Chương 12", ["s" * 500])
    echo = EchoProvider()
    rc = actions.execute_job(
        "rewrite", {"chunk_max_chars": 300}, wd300, job_id="t53",
        providers=[echo], sleep=_NO_SLEEP,
    )
    assert rc == ExitCode.SUCCESS
    assert len(echo.prompts) == 2  # 500 ký tự với biên 300 → 300+200

    wd100 = _workdir(tmp_path / "w2")
    _seed_chapter(wd100, 12, "Chương 12", ["s" * 500])
    clamped = EchoProvider()
    rc2 = actions.execute_job(
        "rewrite", {"chunk_max_chars": 100}, wd100, job_id="t53",
        providers=[clamped], sleep=_NO_SLEEP,
    )
    assert rc2 == ExitCode.SUCCESS
    # kẹp biên dưới 200 → 500 ký tự = 200+200+100 → 3 chunk
    evs = [e for e in _events(capsys) if e["type"] == "progress" and e["total"] == 3]
    assert [e["done"] for e in evs] == [1, 2, 3]
    # 2 mảnh "s"*200 giống hệt nhau → cache dedupe → chỉ 2 lần gọi provider thật
    assert len(clamped.prompts) == 2


def test_split_sentences_for_context():
    assert split_sentences("Một. Hai? Ba! Bốn.") == ["Một.", "Hai?", "Ba!", "Bốn."]


def test_load_glossary(tmp_path):
    f = tmp_path / "glossary.json"
    f.write_text(json.dumps({"Lã Âm": "Cổ Oai"}), encoding="utf-8")
    assert load_glossary(f) == {"Lã Âm": "Cổ Oai"}
    assert load_glossary(tmp_path / "vắng.json") == {}
    bad = tmp_path / "bad.json"
    bad.write_text("[1, 2]", encoding="utf-8")  # không phải object
    with pytest.raises(ValueError, match="glossary"):
        load_glossary(bad)


# ---------- T5.5: fingerprint cache theo glossary — chỉ vô hiệu phần bị đụng ----------


def test_glossary_change_invalidates_only_affected_parts():
    part = "Nhiên Dạ bước vào."
    key0 = cache_key(part, glossary_subset(part, {"Nhiên Dạ": "Nhiên Khanh"}))
    # đổi nghía thuật ngữ ĐANG DÙNG trong phần → key đổi (only affected)
    key1 = cache_key(part, glossary_subset(part, {"Nhiên Dạ": "Nhiên Khanh Mới"}))
    assert key1 != key0
    # sửa mục KHÔNG đắc dùng trong phần này → subset không đổi → key giữ nguyên
    key2 = cache_key(part, glossary_subset(part, {"Lã Âm": "Cổ Oai"}))
    assert key2 == cache_key(part, {})


# ---------- provider interface (fake provider) ----------


def test_client_trims_and_records_prompts():
    p = FakeProvider(["   văn   đã  trim   "])
    prompt = build_prompt("Gốc.", {}, "")
    text, name, calls = LLMClient([p], sleep=_NO_SLEEP).complete(prompt)
    assert text == "văn   đã  trim"  # output handling: trim hai đầu (không đụng space trong)
    assert name == "fake" and calls == 1
    assert p.prompts == [prompt]  # prompt inputs truyền nguyên vẹn


def test_client_network_error_slides_to_next_provider():
    p_err = FakeProvider([ProviderError("mạng đứt")])
    p_ok = FakeProvider(["văn dự phòng"])
    text, name, calls = LLMClient([p_err, p_ok], sleep=_NO_SLEEP, max_rounds=1).complete("x")
    assert text == "văn dự phòng"
    assert calls == 2
    assert p_err.calls == 1 and p_ok.calls == 1


def test_client_empty_output_is_error_too():
    p_empty = FakeProvider(["   "])
    p_ok = FakeProvider(["có văn"])
    text, _name, _calls = LLMClient([p_empty, p_ok], sleep=_NO_SLEEP).complete("x")
    assert text == "có văn"
    assert p_empty.calls == 1 and p_ok.calls == 1


def test_client_exhausts_rounds_raises_backend_error():
    class AlwaysFail(FakeProvider):
        def complete(self, prompt):
            self.calls += 1
            raise ProviderError("cháy")

    p = AlwaysFail([])
    client = LLMClient([p], sleep=_NO_SLEEP, max_rounds=2)
    with pytest.raises(ProviderError, match="thất bại"):
        client.complete("x")
    assert p.calls == 2  # max_rounds chặn vòng lặp vô hạn


def test_client_rate_limited_raises_immediately_up():
    p = FakeProvider([RateLimited("fake 429: hết quota")])

    class NoSleep:
        calls = 0

        def __call__(self, seconds):
            NoSleep.calls += 1

    with pytest.raises(RateLimited, match="429"):
        LLMClient([p], sleep=NoSleep(), max_rounds=3).complete("x")
    assert NoSleep.calls == 0  # quota không tốn sleep — sự xử lý ở tầng stage
    assert p.calls == 1


# ---------- T5.7: phân loại lỗi quota/auth/transient + backoff bounded + jitter ----------


def test_client_auth_error_raises_immediately():
    p = FakeProvider([AuthError("HTTP 401: key sai")])
    with pytest.raises(AuthError, match="fake: HTTP 401"):
        LLMClient([p], sleep=_NO_SLEEP, max_rounds=3).complete("x")
    assert p.calls == 1  # sai credentials — không spin, không slide sang provider kế


def test_client_backoff_bounded_with_jitter():
    sleeps: list[float] = []
    p = FakeProvider([ProviderError("nát 1"), ProviderError("nát 2")])
    with pytest.raises(ProviderError):  # cạn vòng → ném rõ, không vòng vô hạn
        LLMClient([p], sleep=sleeps.append, max_rounds=2, jitter=lambda _d: 1.25).complete("x")
    assert sleeps == [10 + 1.25, 20 + 1.25]  # luỹ thừa + jitter, mọi bước ≤ biên 120s
    assert all(s <= 120 for s in sleeps)


def test_quota_not_before_rate_is_short():
    kind, nb = quota_not_before("fake: 429: too many requests")
    assert kind == "rate"
    t = datetime.strptime(nb, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert t - datetime.now(timezone.utc) <= timedelta(seconds=90)  # chờ ngắn, không spin


def test_quota_not_before_daily_is_durable():
    kind, nb = quota_not_before("openrouter: 429: free-models-per-day limit exceeded")
    assert kind == "daily"
    assert nb.endswith("Z")
    t = datetime.strptime(nb, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    # durable wait: đúng nửa đêm UTC (ngày mai) — pha giờ hiện tại không ảnh hưởng
    assert t.hour == t.minute == t.second == 0
    assert t > datetime.now(timezone.utc)


def test_rewrite_bad_credentials_permanent(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn gốc để thử key sai."])
    bad = FakeProvider([AuthError("HTTP 401: key sai")])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t57", providers=[bad], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.PERMANENT  # credentials sai → dừng, không retryable
    evs = _events(capsys)
    final = [e for e in evs if e["type"] == "final"][-1]
    assert final["status"] == "failed" and "401" in final["summary"]  # nói rõ lỗi
    assert bad.calls == 1  # không spin qua các chương/part
    assert not (wd / "chapters" / "0012" / "rewritten.txt").exists()


def test_rewrite_daily_quota_waits_until_midnight(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn để thử quota ngày."])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t57",
        providers=[FakeProvider([RateLimited("free-models-per-day limit")])],
        sleep=_NO_SLEEP,
    )
    assert rc == ExitCode.QUOTA_WAIT
    evs = _events(capsys)
    q = next(e for e in evs if e["type"] == "quota_wait")
    nb = datetime.strptime(q["not_before"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    # durable wait: đúng nửa đêm UTC — pha giờ chạy test không ảnh hưởng
    assert nb.hour == nb.minute == nb.second == 0
    assert nb > datetime.now(timezone.utc)
    final = [e for e in evs if e["type"] == "final"][-1]
    assert "daily" in final["summary"]  # Node biết loại quota từ summary


def test_resolve_providers_policy_whitelist():
    with pytest.raises(ValueError, match="policy"):
        resolve_providers("openai-paid")
    with pytest.raises(ValueError):
        resolve_providers("   ")
    assert set(PROVIDER_POLICY) == {"gemini", "openrouter", "devkit"}
    providers = resolve_providers("gemini,openrouter,devkit")
    assert [p.name for p in providers] == ["gemini", "openrouter", "devkit"]


def test_resolve_providers_default_uses_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DEVKIT_API_KEY", raising=False)
    assert resolve_providers() == []                    # không key → không provider
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    order = resolve_providers()
    assert [p.name for p in order] == ["gemini"]        # mặc định gemini trước
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    order = resolve_providers()
    assert [p.name for p in order] == ["gemini", "openrouter"]
    monkeypatch.setenv("DEVKIT_API_KEY", "k")
    order = resolve_providers()
    assert [p.name for p in order] == ["gemini", "openrouter", "devkit"]


def test_gemini_provider_missing_key_clear_error():
    p = resolve_providers("gemini")[0]
    # không set GEMINI_API_KEY → ProviderError nói rõ thiếu key
    import os
    old = os.environ.get("GEMINI_API_KEY")
    os.environ.pop("GEMINI_API_KEY", None)
    try:
        with pytest.raises(ProviderError, match="GEMINI_API_KEY"):
            p.complete("prompt")
    finally:
        if old is not None:
            os.environ["GEMINI_API_KEY"] = old


def test_openrouter_provider_custom_model_and_key():
    p = resolve_providers(
        "openrouter",
        ai_model="deepseek/deepseek-chat",
        openrouter_api_key="sk-test-key",
    )[0]
    assert p.name == "openrouter"
    assert p.model == "deepseek/deepseek-chat"
    assert p.api_key == "sk-test-key"


def test_openrouter_provider_missing_key_clear_error():
    p = resolve_providers("openrouter")[0]
    import os
    old = os.environ.get("OPENROUTER_API_KEY")
    os.environ.pop("OPENROUTER_API_KEY", None)
    try:
        with pytest.raises(ProviderError, match="OPENROUTER_API_KEY"):
            p.complete("prompt")
    finally:
        if old is not None:
            os.environ["OPENROUTER_API_KEY"] = old


def test_devkit_provider_custom_model_and_key():
    p = resolve_providers(
        "devkit",
        ai_model="deepseek-r1-550b",
        devkit_api_key="sk-devkit-key",
        devkit_base_url="https://agent.devkit.vn/v1",
    )[0]
    assert p.name == "devkit"
    assert p.model == "deepseek-r1-550b"
    assert p.api_key == "sk-devkit-key"
    assert p.base_url == "https://agent.devkit.vn/v1"


def test_devkit_provider_missing_key_clear_error():
    p = resolve_providers("devkit")[0]
    import os
    old = os.environ.get("DEVKIT_API_KEY")
    os.environ.pop("DEVKIT_API_KEY", None)
    try:
        with pytest.raises(ProviderError, match="DEVKIT_API_KEY"):
            p.complete("prompt")
    finally:
        if old is not None:
            os.environ["DEVKIT_API_KEY"] = old


# ---------- rewrite stage (execute_job, fake providers, workdir seed) ----------


def test_rewrite_happy_path(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Một. Hai. Ba. Bốn. " + "x" * 1200, "y" * 700])
    echo = EchoProvider()
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t53", providers=[echo], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.SUCCESS
    out = (wd / "chapters" / "0012" / "rewritten.txt").read_text(encoding="utf-8")
    assert out.startswith("Chương 12\n\n")  # title giữ đầu
    assert "x" * 10 in out  # part 1 echo nguyên văn (đã qua validate pass)
    norm = (wd / "chapters" / "0012" / "normalized.txt").read_text(encoding="utf-8")
    assert norm.endswith("y" * 700 + "\n")  # raw artifact KHÔNG bị đụng

    evs = _events(capsys)
    statuses = {e["chapter_no"]: e["state"] for e in evs if e["type"] == "chapter_status"}
    assert statuses == {12: "rewritten"}
    arts = [e for e in evs if e["type"] == "artifact_ready"]
    assert arts and arts[0]["kind"] == "rewritten_text"
    assert arts[0]["path"] == "chapters/0012/rewritten.txt"
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "success"
    # cache entry ghi với key định danh
    cache_files = list((wd / "rewrite-cache").glob("*.txt"))
    assert len(cache_files) == 2
    # cache entry ghi với key định danh — đối chiếu SET (glob không bảo đảm thứ tự)
    fp = model_fingerprint()
    assert {f.stem for f in cache_files} == {
        cache_key(_part(echo.prompts[0]), {}, model=fp),
        cache_key(_part(echo.prompts[1]), {}, model=fp),
    }


def test_rewrite_context_continuity_between_parts(tmp_path):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 5, "Chương 5", ["Một. Hai. Ba. Bốn. " + "x" * 1200, "y" * 700])
    echo = EchoProvider()
    actions.execute_job("rewrite", {}, wd, job_id="t53", providers=[echo], sleep=_NO_SLEEP)
    assert len(echo.prompts) == 2  # 2 phần
    # prompt phần 2 mang ngữ cảnh: 3 câu CUỐI của kết quả phần 1
    assert "Ba. Bốn." in echo.prompts[1]


def test_rewrite_cache_hit_skips_provider(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Một đoạn văn đầu tiên.", "Đoạn hai nữa."])
    actions.execute_job(
        "rewrite", {}, wd, job_id="t53", providers=[EchoProvider()], sleep=_NO_SLEEP
    )
    _events(capsys)  # flush
    never = FakeProvider([])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t53", providers=[never], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.SUCCESS
    assert never.calls == 0  # cache trọn bộ: không gọi provider nào lần chạy 2


def test_rewrite_validation_fallback_needs_review(tmp_path, capsys):
    wd = _workdir(tmp_path)
    seed = (
        "Đoạn văn gốc cần được viết lại dài vừa đủ: tính từ đầu dòng cho tới cuối "
        "của văn bản thử nghiệm này là khoảng một trăm năm mươi ký tự trơn nhẵn."
    )
    _seed_chapter(wd, 12, "Chương 12", [seed])
    junk = LeadinEcho()  # lời dẫn AI + ratio ~1.1 → validate fail mọi attempt (không dùng phần gốc lẫn lộn)
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t53", providers=[junk], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.NEEDS_REVIEW
    evs = _events(capsys)
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "needs_review"
    assert any("lời dẫn AI" in e["message"] for e in evs if e["type"] == "error")
    out = (wd / "chapters" / "0012" / "rewritten.txt").read_text(encoding="utf-8")
    assert seed in out  # giữ bản gốc thay vì mất văn
    cache_files = list((wd / "rewrite-cache").glob("*.txt"))
    assert cache_files == []  # fallback KHÔNG được cache
    assert junk.calls >= 3  # thử đúng số attempt rồi mới fallback


def test_rewrite_network_fallback_is_retryable(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn gốc để thử mạng nát."])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t53",
        providers=[FakeProvider([ProviderError("mạng đứt rõ")])], sleep=_NO_SLEEP,
    )
    assert rc == ExitCode.RETRYABLE  # Node schedule lại; cache bảo phần đã xong
    evs = _events(capsys)
    err = [e for e in evs if e["type"] == "error"][-1]
    assert err["retryable"] is True
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "failed"


def test_rewrite_rate_limited_is_quota_wait(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn để thử hết quota."])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t53",
        providers=[FakeProvider([RateLimited("429: hết quota")])], sleep=_NO_SLEEP,
    )
    assert rc == ExitCode.QUOTA_WAIT
    evs = _events(capsys)
    q = next(e for e in evs if e["type"] == "quota_wait")
    assert q["backend"] == "fake"  # LLMClient wrap tên provider vào lỗi quota
    assert q["not_before"].endswith("Z")  # ISO chuẩn — Node new Date() parse được
    final = [e for e in evs if e["type"] == "final"][-1]
    assert final["status"] == "quota_wait"
    assert not (wd / "chapters" / "0012" / "rewritten.txt").exists()


def test_rewrite_provider_policy_violation_is_permanent(tmp_path, capsys):
    rc = actions.execute_job(
        "rewrite", {"providers": "openai-paid"}, _workdir(tmp_path), job_id="t53"
    )
    assert rc == ExitCode.PERMANENT  # policy chặn provider trả phí/lạ
    evs = _events(capsys)
    assert "policy" in [e for e in evs if e["type"] == "final"][-1]["summary"]


def test_rewrite_without_any_provider_is_permanent(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DEVKIT_API_KEY", raising=False)
    rc = actions.execute_job(
        "rewrite", {}, _workdir(tmp_path), job_id="t53", sleep=_NO_SLEEP
    )
    assert rc == ExitCode.PERMANENT
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "không có provider" in final["summary"]


# ---------- T5.6: QA gate chương ----------


class CJKEcho(EchoProvider):
    """Echo nhưng nhét dư CJK — validate part đạt, QA chương phải bắt."""

    def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompts.append(prompt)
        return "天 " + _part(prompt)


def test_rewrite_qa_failed_chapter_needs_review(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Hắn bước vào vườn thượng uyển."])
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t56", providers=[CJKEcho()], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.NEEDS_REVIEW  # chương trượt QA KHÔNG được coi thành công
    evs = _events(capsys)
    assert [e for e in evs if e["type"] == "final"][-1]["status"] == "needs_review"
    assert any("trượt QA" in e["message"] and "CJK" in e["message"]
               for e in evs if e["type"] == "error")
    states = [e["state"] for e in evs
              if e["type"] == "chapter_status" and e["chapter_no"] == 12]
    assert states == ["rewritten"]  # không có qa_passed — TTS không được vào


def test_rewrite_qa_runs_on_cache_hit(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Hắn bước vào vườn thượng uyển."])
    ok = EchoProvider()
    actions.execute_job("rewrite", {}, wd, job_id="t56a", providers=[ok], sleep=_NO_SLEEP)
    # bẩn cache ĐÚNG FORMAT v2 (checksum còn hợp lệ): chèn CJK vào bản đã cache
    for f in (wd / "rewrite-cache").glob("*.txt"):
        _cp, _sep, text = f.read_text(encoding="utf-8").partition("\n")
        poisoned = "天 " + text
        f.write_text(
            hashlib.sha256(poisoned.encode("utf-8")).hexdigest() + "\n" + poisoned,
            encoding="utf-8",
        )
    fresh = EchoProvider()
    # Mặc định Phase 1: DEFAULT_CACHE_HEAL = True → cache hit trượt validate được tự sửa
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t56b", providers=[fresh], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.SUCCESS
    assert fresh.calls == 1  # gọi provider mới để tự sửa bản cache bị hỏng
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert final["status"] == "success"

    # Khi opt-out (cache_heal=False): giữ nguyên bản cache lỗi và báo NEEDS_REVIEW
    poisoned_file = next(iter((wd / "rewrite-cache").glob("*.txt")))
    _cp, _sep, text = poisoned_file.read_text(encoding="utf-8").partition("\n")
    poisoned2 = "天 " + text
    poisoned_file.write_text(
        hashlib.sha256(poisoned2.encode("utf-8")).hexdigest() + "\n" + poisoned2,
        encoding="utf-8",
    )
    no_heal_prov = EchoProvider()
    rc_no_heal = actions.execute_job(
        "rewrite", {"cache_heal": False}, wd, job_id="t56c", providers=[no_heal_prov], sleep=_NO_SLEEP
    )
    assert rc_no_heal == ExitCode.NEEDS_REVIEW
    assert no_heal_prov.calls == 0
    assert any("trượt QA" in e["message"] for e in _events(capsys) if e["type"] == "error")


# ---------- T5.8: cache integrity — corrupt bị từ chối; model fingerprint ----------


def test_cache_corrupt_rejected_and_regenerated(tmp_path, capsys):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn quan trọng để thử cache."])
    actions.execute_job("rewrite", {}, wd, job_id="t58", providers=[EchoProvider()],
                        sleep=_NO_SLEEP)
    f = next(iter((wd / "rewrite-cache").glob("*.txt")))
    f.write_text(f.read_text(encoding="utf-8")[:80], encoding="utf-8")  # cắt cụt → corrupt
    fresh = EchoProvider()
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t58", providers=[fresh], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.SUCCESS
    assert fresh.calls == 1  # corrupt bị từ chối — provider sinh lại phần đó
    # cache mới ghi lại đúng format, nội dung khớp bản gốc đã cache
    key = cache_key(_part(fresh.prompts[0]), {}, model=model_fingerprint())
    assert load_cache(wd / "rewrite-cache").get(key) == _part(fresh.prompts[0])


def test_model_change_invalidates_cache(tmp_path, monkeypatch):
    wd = _workdir(tmp_path)
    _seed_chapter(wd, 12, "Chương 12", ["Đoạn văn cần hai lần viết lại nhé."])
    actions.execute_job("rewrite", {}, wd, job_id="t58", providers=[EchoProvider()],
                        sleep=_NO_SLEEP)
    assert len(list((wd / "rewrite-cache").glob("*.txt"))) == 1
    monkeypatch.setenv("VIETLAI_GEMINI_MODEL", "gemini-đổi-model")
    echo2 = EchoProvider()
    actions.execute_job("rewrite", {}, wd, job_id="t58", providers=[echo2], sleep=_NO_SLEEP)
    assert echo2.calls == 1  # model đổi → key đổi → sinh lại, không ăn cache cũ
    assert len(list((wd / "rewrite-cache").glob("*.txt"))) == 2  # entry cũ chỉ bỏ dùng


def test_rewrite_missing_normalized_counts_skip(tmp_path, capsys):
    wd = _workdir(tmp_path)
    (wd / "chapters" / "0007").mkdir(parents=True)  # không có normalized.txt
    rc = actions.execute_job(
        "rewrite", {}, wd, job_id="t56", providers=[EchoProvider()], sleep=_NO_SLEEP
    )
    assert rc == ExitCode.NEEDS_REVIEW  # bỏ chương vì thiếu input → không báo success
    final = [e for e in _events(capsys) if e["type"] == "final"][-1]
    assert "1 chương thiếu input" in final["summary"]

