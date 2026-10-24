"""T5.1 — fixtures chứng minh mỗi adapter xuất chương ĐÚNG THỨ TỰ; nguồn lạ/khoá fail rõ.

Hoàn toàn offline: fetcher là fake map URL→fixture trong tests/fixtures/.
"""

from __future__ import annotations

import pathlib

import pytest
import requests

from story_audio.sources import (
    FetchError,
    LockedChapter,
    TruyendichAdapter,
    UnsupportedSource,
    WebnovelVnAdapter,
    fetch_chapter,
    fetch_sequence,
    fetch_with_retries,
    resolve_adapter,
)

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
WEB_START = "https://webnovel.vn/tien-dao-cot/chuong-12"
TD_START = "https://truyendich.space/doc-truyen/convert/tien-dao-cot/chuong-5"


def _fx(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _fake_fetch(mapping: dict[str, str]):
    """Fetcher offline: URL chứa key → fixture; không khớp → fail test rõ ràng."""
    calls: list[str] = []

    def get(url: str) -> str:
        calls.append(url)
        for key, html in mapping.items():
            if key in url:
                return html
        raise AssertionError(f"URL không mong đợi: {url}")

    get.calls = calls  # type: ignore[attr-defined]
    return get


def test_resolve_adapter():
    assert isinstance(resolve_adapter(WEB_START), WebnovelVnAdapter)
    assert isinstance(resolve_adapter(TD_START), TruyendichAdapter)
    with pytest.raises(UnsupportedSource, match="không được hỗ trợ"):
        resolve_adapter("https://sachmoi.vn/doc/chuong-12")


TD_REAL_START = "https://truyendich.space/doc-truyen/xich-tam-tuan-thien/chuong-2845"


def test_truyendich_real_url_no_type_segment():
    # URL THẬT của truyendich.space KHÔNG có segment loại (convert/...) giữa
    # doc-truyen và chuong-N — regex cứng 2 segments làm job thật luôn hỏng.
    fetch = _fake_fetch({"xich-tam-tuan-thien/chuong-2845": _fx("truyendich_ch5.html")})
    rec = fetch_chapter(TD_REAL_START, fetch=fetch)
    assert rec.no == 2845


# --- Curl-fallback: site chặn fingerprint TLS của python-requests (403 verify-human)
# nhưng chấp nhận curl — hoàn tất ở FF-1 khi job thật chạy.
def test_curl_fallback_on_403(monkeypatch):
    import requests

    import story_audio.sources as src

    class Blocked:
        headers: dict = {}

        def get(self, url: str, timeout=None):
            raise requests.HTTPError(f"403 {url}")

    calls: list[str] = []
    monkeypatch.setattr(src, "_curl_fetch", lambda u: (calls.append(u), "--HTML--")[1])
    f = src.requests_fetcher(session=Blocked(), sleep=lambda _s: None)
    assert f("https://truyendich.space/doc-truyen/a/chuong-1") == "--HTML--"
    assert calls == ["https://truyendich.space/doc-truyen/a/chuong-1"]


def test_curl_fallback_refused_keeps_retries(monkeypatch):
    import requests

    import story_audio.sources as src

    class Blocked:
        headers: dict = {}

        def get(self, url: str, timeout=None):
            raise requests.HTTPError(f"403 {url}")

    monkeypatch.setattr(src, "_curl_fetch", lambda u: (_ for _ in ()).throw(RuntimeError("curl hỏng")))
    f = src.requests_fetcher(session=Blocked(), sleep=lambda _s: None)
    with pytest.raises(src.FetchError):
        f("https://truyendich.space/doc-truyen/a/chuong-1")


def test_webnovel_ordered_sequence():
    start = WEB_START  # không có "/" cuối → _clean_url giữ nguyên lần fetch đầu
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_ch13.html"),
        }
    )
    recs = fetch_sequence(start, 2, fetch=fetch)

    assert [r.no for r in recs] == [12, 13]  # thứ tự ổn định theo số chương
    assert [r.title for r in recs] == ["Chương 12: Đường máu", "Chương 13: Bóng tối"]
    assert recs[0].url == start  # URL nguồn gốc của từng chương được giữ

    # fetch chỉ đụng đúng 2 URL theo thứ tự (chương 13 đi theo link "Chương sau")
    assert fetch.calls == [start, "https://webnovel.vn/tien-dao-cot/chuong-13"]  # type: ignore[attr-defined]

    joined = " ".join(recs[0].paragraphs)
    assert "Dòng một mờ dần trong gió" in joined
    assert "Dòng hai thì thầm khép lại." in joined  # <br> tách dòng
    # rác bị lọc: link/ảnh (cả khối), script, "nhóm dịch:", URL chính
    for junk in ("nhóm dịch", "http", "Mua đầy đủ", "quảng cáo", "thu thập dữ liệu"):
        assert junk not in joined


def test_webnovel_locked_marker():
    fetch = _fake_fetch({"khac/chuong-40": _fx("webnovel_locked.html")})
    with pytest.raises(LockedChapter, match="Đăng nhập để đọc ngay"):
        fetch_chapter("https://webnovel.vn/khac/chuong-40", fetch=fetch)


def test_webnovel_short_content_locked():
    fetch = _fake_fetch({"khac/chuong-41": _fx("webnovel_short.html")})
    with pytest.raises(LockedChapter, match="nội dung quá ngắn"):
        fetch_chapter("https://webnovel.vn/khac/chuong-41", fetch=fetch)


def test_webnovel_wrong_url_shape():
    # host đúng nhưng thiếu hậu tố chuong-N → ValueError rõ ràng (không phải UnsupportedSource)
    with pytest.raises(ValueError, match=r"không phải URL chương dạng"):
        fetch_chapter("https://webnovel.vn/tien-dao-cot/chap-12", fetch=lambda u: "")


def test_truyendich_extract_and_title():
    fetch = _fake_fetch({"doc-truyen/convert/tien-dao-cot/chuong-5": _fx("truyendich_ch5.html")})
    rec = fetch_chapter(TD_START, fetch=fetch)

    assert rec.no == 5
    assert rec.title == "Chương 5"  # title tổng hợp như bản cũ
    assert len(rec.paragraphs) == 4  # 6 dòng − 1 "Cảm tạ" − 1 "?…"
    assert rec.paragraphs[0] == "Tống Tịnh mở mắt, hơi lạnh bám trên da thịt vẫn chưa tan."
    assert all("Cảm tạ" not in p for p in rec.paragraphs)
    assert "Lửa trong bếp đã tàn, than còn đỏ ẩn hiện." in rec.paragraphs  # whitespace co lại


def test_truyendich_ordered_sequence():
    fetch = _fake_fetch(
        {
            "doc-truyen/convert/tien-dao-cot/chuong-5": _fx("truyendich_ch5.html"),
            "doc-truyen/convert/tien-dao-cot/chuong-6": _fx("truyendich_ch6.html"),
        }
    )
    recs = fetch_sequence(TD_START, 2, fetch=fetch)
    assert [r.no for r in recs] == [5, 6]
    assert [r.title for r in recs] == ["Chương 5", "Chương 6"]
    # truyendich đi theo +1 số chương (không có link next)
    assert fetch.calls == [TD_START, TD_START.replace("chuong-5", "chuong-6")]  # type: ignore[attr-defined]


def test_truyendich_short_locked():
    fetch = _fake_fetch({"chuong-7": _fx("truyendich_short.html")})
    with pytest.raises(LockedChapter, match=r"nội dung quá ngắn \(2 đoạn\)"):
        fetch_chapter(
            "https://truyendich.space/doc-truyen/convert/tien-dao-cot/chuong-7", fetch=fetch
        )


def test_truyendich_strange_page():
    fetch = _fake_fetch({"chuong-8": "<html><body><h1>captcha</h1></body></html>"})
    # trang lạ/challenge (Cloudflare, veil) = BlockedPage — LỖI TẠM THỜI
    # (subclass ValueError để Bullet mọi chỗ cũ vẫn bắt ValueError)
    with pytest.raises(ValueError, match="prose-novel"):
        fetch_chapter(
            "https://truyendich.space/doc-truyen/convert/tien-dao-cot/chuong-8", fetch=fetch
        )
    from story_audio.sources import BlockedPage

    fetch = _fake_fetch({"chuong-8": "<html><body><h1>captcha</h1></body></html>"})
    with pytest.raises(BlockedPage, match="prose-novel"):
        fetch_chapter(
            "https://truyendich.space/doc-truyen/convert/tien-dao-cot/chuong-8", fetch=fetch
        )


def test_truyendich_wrong_url_shape():
    # truyendich: thiếu path doc-truyen/<loại>/<slug> → lỗi dạng URL rõ ràng
    with pytest.raises(ValueError, match="doc-truyen"):
        fetch_chapter("https://truyendich.space/doc-truyen/chuong-5", fetch=lambda u: "")


def test_webnovel_missing_container():
    fetch = _fake_fetch({"chuong-9": "<html><body><p>không có gì</p></body></html>"})
    with pytest.raises(ValueError, match="#chapter-c"):
        fetch_chapter("https://webnovel.vn/khac/chuong-9", fetch=fetch)


def test_fetch_with_retries_offline():
    state = {"n": 0}

    def flaky(url: str) -> str:
        state["n"] += 1
        if state["n"] < 3:
            raise requests.ConnectionError("mạng đứt")
        return "<html>ok</html>"

    # sleep giả → test không tốn thời gian; backoff thật chạy ở runtime
    text = fetch_with_retries(flaky, "https://x", sleep=lambda s: None)
    assert text == "<html>ok</html>"
    assert state["n"] == 3


def test_fetch_with_retries_exhausted():
    def always(url: str) -> str:
        raise requests.Timeout("quá chậm")

    with pytest.raises(FetchError, match="thất bại sau 3 lần"):
        fetch_with_retries(always, "https://x", sleep=lambda s: None)
