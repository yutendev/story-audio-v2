"""T5.2 — normalize thuần + stage extract/normalize: raw và normalized là 2 artifact riêng.

Offline: fetcher fake; import normalize không side-effect, không phụ thuộc cwd.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys

import pytest

from story_audio import actions
from story_audio import sources
from story_audio.exit_codes import ExitCode
from story_audio.normalize import load_replacements, normalize_brackets, normalize_text

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
WEB_START = "https://webnovel.vn/tien-dao-cot/chuong-12"
TD_START = "https://truyendich.space/doc-truyen/convert/tien-dao-cot/chuong-5"


def _fx(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _fake_fetch(mapping: dict[str, str]):
    def get(url: str) -> str:
        for key, html in mapping.items():
            if key in url:
                return html
        raise AssertionError(f"URL không mong đợi: {url}")

    return get


def _workdir(tmp_path: pathlib.Path) -> pathlib.Path:
    wd = tmp_path / "work"
    wd.mkdir()
    return wd


def _events(capsys) -> list[dict]:
    out = capsys.readouterr().out
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def _final(evs: list[dict]) -> dict:
    return evs[-1]


# ---------- normalize_text thuần ----------


def test_normalize_whitespace_and_trim():
    assert normalize_text("A   b\t\nc  ") == "A b c"
    assert normalize_text("   ") == ""
    assert normalize_text("chưa chỉnh") == "chưa chỉnh"  # không replacements → chỉ co space


def test_replacements_word_boundary_longest_first():
    # key dài phải thắng (sort độ dài giảm dần như bản cũ)
    assert normalize_text("Lã Âm ra đòn", {"Lã": "Lã Âm", "Lã Âm": "Cổ Oai"}) == "Cổ Oai ra đòn"
    assert normalize_text(
        "Nhiên Dạ đứng yên", {"Nhiên Dạ": "Nhiên Khanh"}
    ) == "Nhiên Khanh đứng yên"
    # biên từ: "Ch" không được ăn vào trong "Chương"
    assert normalize_text("Chương mới", {"Ch": "X"}) == "Chương mới"


def test_load_replacements(tmp_path):
    f = tmp_path / "replace.json"
    f.write_text(json.dumps({"Lã": "Lã Âm"}), encoding="utf-8")
    assert load_replacements(f) == {"Lã": "Lã Âm"}
    # file vắng → {} (không cấu hình replacements là bình thường, không fail)
    assert load_replacements(tmp_path / "khong-ton-tai.json") == {}
    # JSON hỏng → ValueError rõ ràng (không nuốt)
    bad = tmp_path / "bad.json"
    bad.write_text("{oops", encoding="utf-8")
    with pytest.raises(ValueError):
        load_replacements(bad)


# ---------- import sạch & CWD independence ----------


def test_import_normalize_has_no_cwd_side_effects(tmp_path):
    src_dir = pathlib.Path(actions.__file__).parent.parent  # .../src
    code = "import story_audio.normalize as n; print(n.normalize_text('a  b'))"
    env = {**os.environ, "PYTHONPATH": str(src_dir)}
    r = subprocess.run(
        [sys.executable, "-c", code], cwd=tmp_path, env=env,
        capture_output=True, text=True, check=True,
    )
    assert r.stdout.strip() == "a b"
    # cwd vốn rỗng phải vẫn rỗng — import/giữ pure không tạo file nào ở cwd
    assert list(tmp_path.iterdir()) == []


# ---------- extract stage ----------


def test_extract_writes_raw_artifacts(tmp_path):
    wd = _workdir(tmp_path)
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_ch13.html"),
        }
    )
    rc = actions.execute_job(
        "extract", {"url": WEB_START, "count": 2}, wd, job_id="t52", fetch=fetch
    )
    assert rc == ExitCode.SUCCESS

    raw12 = (wd / "chapters" / "0001" / "text.txt").read_text(encoding="utf-8")  # vị trí 1 trong job
    lines = raw12.splitlines()
    assert lines[0] == "Chương 12: Đường máu"  # dòng đầu = title
    assert "Dòng một mờ dần trong gió" in lines  # <br> đã tách
    assert all("nhóm dịch" not in ln for ln in lines)  # rác không lọt raw
    assert all(not ln.startswith("http") for ln in lines)
    assert "Mua đầy đủ tại đây" not in raw12

    raw13 = (wd / "chapters" / "0002" / "text.txt").read_text(encoding="utf-8")
    assert raw13.splitlines()[0] == "Chương 13: Bóng tối"


def test_extract_events_follow_protocol(tmp_path, capsys):
    wd = _workdir(tmp_path)
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_ch13.html"),
        }
    )
    actions.execute_job(
        "extract", {"url": WEB_START, "count": 2}, wd, job_id="t52", fetch=fetch
    )
    evs = _events(capsys)

    assert evs[0]["type"] == "stage_started" and evs[0]["stage"] == "extract"
    assert [e["seq"] for e in evs] == sorted(e["seq"] for e in evs)  # seq tăng đều
    final = _final(evs)
    assert final["type"] == "final" and final["status"] == "success"

    statuses = {e["chapter_no"]: e["state"] for e in evs if e["type"] == "chapter_status"}
    # chapter_no trong event = VỊ TRÍ trong job (1..N), không phải số chương sách
    assert statuses == {1: "downloaded", 2: "downloaded"}

    arts = [e for e in evs if e["type"] == "artifact_ready"]
    assert len(arts) == 2
    for a in arts:
        assert a["kind"] == "chapter_text"
        assert re.fullmatch(r"[0-9a-f]{64}", a["checksum"])
        assert re.fullmatch(r"chapters/\d{4}/text\.txt", a["path"])

    last_progress = [e for e in evs if e["type"] == "progress"][-1]
    assert (last_progress["done"], last_progress["total"]) == (2, 2)


def test_extract_missing_payload_is_permanent(tmp_path, capsys):
    rc = actions.execute_job("extract", {"count": 2}, _workdir(tmp_path), job_id="t52")
    assert rc == ExitCode.PERMANENT
    evs = _events(capsys)
    assert _final(evs)["status"] == "failed"
    assert any(e["type"] == "error" for e in evs)


def test_extract_count_zero_is_permanent(tmp_path):
    rc = actions.execute_job(
        "extract", {"url": WEB_START, "count": 0}, _workdir(tmp_path), job_id="t52"
    )
    assert rc == ExitCode.PERMANENT


def test_extract_unknown_source_is_permanent(tmp_path, capsys):
    rc = actions.execute_job(
        "extract",
        {"url": "https://sachmoi.vn/doc/chuong-1", "count": 1},
        _workdir(tmp_path),
        job_id="t52",
        fetch=lambda u: "",
    )
    assert rc == ExitCode.PERMANENT
    assert "không được hỗ trợ" in _final(_events(capsys))["summary"]


def test_extract_locked_midway_is_needs_review(tmp_path, capsys):
    wd = _workdir(tmp_path)
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_locked.html"),
        }
    )
    rc = actions.execute_job(
        "extract", {"url": WEB_START, "count": 2}, wd, job_id="t52", fetch=fetch
    )
    assert rc == ExitCode.NEEDS_REVIEW  # có phần đã tải + một chương khoá → chờ người duyệt
    evs = _events(capsys)
    assert _final(evs)["status"] == "needs_review"
    assert any("Đăng nhập để đọc ngay" in e["message"] for e in evs if e["type"] == "error")
    assert (wd / "chapters" / "0001" / "text.txt").is_file()  # phần đã tải còn nguyên (vị trí 1)
    assert not (wd / "chapters" / "0002" / "text.txt").exists()  # chương khoá không ghi


# --- extract idempotent (resume): chương đã có text.txt không fetch lại (site chống
# dồn dập: rerun không đốt lại 9 chương cũ), nhưng vẫn phát lại event cho Node. ---
def test_extract_resume_skips_downloaded(tmp_path, capsys):
    wd = _workdir(tmp_path)
    seeded = (wd / "chapters" / "0001")
    seeded.mkdir(parents=True)
    seeded_txt = "Chương 5\n\nTống Tịnh mở mắt, hơi lạnh bám trên da thịt vẫn chưa tan.\n"
    (seeded / "text.txt").write_text(seeded_txt, encoding="utf-8")
    # stub chỉ chấp nhận chương 6 (vị trí 2) — vị trí 1 có file thì KHÔNG được fetch
    fetch = _fake_fetch({"doc-truyen/convert/tien-dao-cot/chuong-6": _fx("truyendich_ch6.html")})

    rc = actions.execute_job("extract", {"url": TD_START, "count": 2}, wd, job_id="t52", fetch=fetch)
    assert rc == ExitCode.SUCCESS

    assert (seeded / "text.txt").read_text(encoding="utf-8") == seeded_txt  # giữ nguyên, không ghi đè
    assert (wd / "chapters" / "0002" / "text.txt").read_text(encoding="utf-8").splitlines()[0] == "Chương 6"

    evs = _events(capsys)
    statuses = {e["chapter_no"]: e["state"] for e in evs if e["type"] == "chapter_status"}
    assert statuses == {1: "downloaded", 2: "downloaded"}  # chương cũ vẫn phát lại event
    arts = [e for e in evs if e["type"] == "artifact_ready"]
    assert {int(re.fullmatch(r"chapters/(\d{4})/text\.txt", a["path"]).group(1)) for a in arts} == {1, 2}


def test_extract_paces_between_fetches(tmp_path, monkeypatch):
    wd = _workdir(tmp_path)
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_ch13.html"),
        }
    )
    sleeps: list[float] = []
    actions.execute_job(
        "extract", {"url": WEB_START, "count": 2}, wd, job_id="t52",
        fetch=fetch, sleep=lambda s: sleeps.append(s),
    )
    assert sleeps == [2.0]  # nghỉ trước mỗi lần fetch sau lần đầu — không dồn dập hit site


def test_extract_locked_first_chapter_is_permanent(tmp_path):
    rc = actions.execute_job(
        "extract",
        {"url": "https://webnovel.vn/khac/chuong-40", "count": 1},
        _workdir(tmp_path),
        job_id="t52",
        fetch=_fake_fetch({"chuong-40": _fx("webnovel_locked.html")}),
    )
    assert rc == ExitCode.PERMANENT  # không tải được chương nào → fail rõ


def test_extract_blocked_page_is_retryable(tmp_path, capsys):
    # trang challenge/veil là TẠM THỜI — job được requeue tự động, không chết PERMANENT
    rc = actions.execute_job(
        "extract",
        {"url": TD_START, "count": 1},
        _workdir(tmp_path),
        job_id="t52",
        fetch=lambda u: "<html><body><h1>Just a moment...</h1></body></html>",
    )
    assert rc == ExitCode.RETRYABLE
    assert _final(_events(capsys))["status"] == "failed"  # final.failed + exit RETRYABLE


def test_extract_fetch_error_is_retryable(tmp_path, capsys):
    def broken(url: str) -> str:
        raise sources.FetchError("mạng đứt giữa chừng")

    rc = actions.execute_job(
        "extract", {"url": WEB_START, "count": 1}, _workdir(tmp_path),
        job_id="t52", fetch=broken,
    )
    assert rc == ExitCode.RETRYABLE  # Node tự schedule lại
    evs = _events(capsys)
    assert _final(evs)["status"] == "failed"
    err = next(e for e in evs if e["type"] == "error")
    assert err["retryable"] is True


# ---------- normalize stage ----------


def test_normalize_keeps_paragraph_boundaries(tmp_path, capsys):
    wd = _workdir(tmp_path)
    fetch = _fake_fetch(
        {
            "tien-dao-cot/chuong-12": _fx("webnovel_ch12.html"),
            "tien-dao-cot/chuong-13": _fx("webnovel_ch13.html"),
        }
    )
    actions.execute_job(
        "extract", {"url": WEB_START, "count": 2}, wd, job_id="t52", fetch=fetch
    )
    _events(capsys)  # flush sự kiện của extract — chỉ đo stage normalize bên dưới
    rc = actions.execute_job(
        "normalize", {"replacements": {"Nhiên Dạ": "Nhiên Khanh"}}, wd, job_id="t52"
    )
    assert rc == ExitCode.SUCCESS

    norm = (wd / "chapters" / "0001" / "normalized.txt").read_text(encoding="utf-8")
    lines = norm.splitlines()
    assert "Nhiên Khanh đứng giữa rừng trúc, máu trên áo chưa kịp khô." in lines
    assert "Nhiên Dạ" not in norm  # replacements đã chạy
    # ranh giới đoạn giữ nguyên: mỗi đoạn 1 dòng, không gộp chung
    assert "Dòng một mờ dần trong gió" in lines
    assert "Dòng hai thì thầm khép lại." in lines
    assert "Vết thương cũ lại nứt ra, cơn đau như thủy triều ập tới." in lines

    evs = _events(capsys)
    statuses = {e["chapter_no"]: e["state"] for e in evs if e["type"] == "chapter_status"}
    assert statuses == {1: "normalized", 2: "normalized"}
    kinds = {e["kind"] for e in evs if e["type"] == "artifact_ready"}
    assert kinds == {"normalized_text"}

    # raw artifact CÒN NGUYÊN — đúng yêu cầu tách raw/normalized
    assert "Nhiên Dạ đứng giữa rừng trúc" in (
        wd / "chapters" / "0001" / "text.txt"
    ).read_text(encoding="utf-8")


def test_normalize_reads_replacements_file_not_cwd(tmp_path, monkeypatch, capsys):
    wd = _workdir(tmp_path)
    rep = tmp_path / "rep.json"
    rep.write_text(json.dumps({"Nhiên Dạ": "Nhiên Khanh"}), encoding="utf-8")

    empty_cwd = tmp_path / "cwd-khac"
    empty_cwd.mkdir()
    monkeypatch.chdir(empty_cwd)  # chạy từ cwd khác — KHÔNG được đụng cwd của quá trình

    seed = wd / "chapters" / "0012"
    seed.mkdir(parents=True)
    (seed / "text.txt").write_text(
        "Chương 12\n\nNhiên Dạ  đứng   đầu.\nHơi thở đều.\n", encoding="utf-8"
    )

    rc = actions.execute_job(
        "normalize", {"replacements_path": str(rep)}, wd, job_id="t52"
    )
    assert rc == ExitCode.SUCCESS
    assert "Nhiên Khanh đứng đầu." in (
        wd / "chapters" / "0012" / "normalized.txt"
    ).read_text(encoding="utf-8")
    assert list(empty_cwd.iterdir()) == []  # cwd vẫn rỗng — không file nào được tạo


def test_normalize_empty_chapter_is_needs_review(tmp_path, capsys):
    wd = _workdir(tmp_path)
    empty = wd / "chapters" / "0007"
    ok = wd / "chapters" / "0012"
    empty.mkdir(parents=True)
    ok.mkdir(parents=True)
    (empty / "text.txt").write_text("Chương 7\n\n", encoding="utf-8")  # chỉ title, 0 đoạn
    (ok / "text.txt").write_text(
        "Chương 12\n\nHơi thở đều.\nGươm im lặng.\n", encoding="utf-8"
    )

    rc = actions.execute_job("normalize", {}, wd, job_id="t52")
    assert rc == ExitCode.NEEDS_REVIEW  # hoàn thành một phần → chờ người duyệt

    evs = _events(capsys)
    statuses = {e["chapter_no"]: e["state"] for e in evs if e["type"] == "chapter_status"}
    assert statuses == {7: "failed", 12: "normalized"}
    assert not (empty / "normalized.txt").exists()  # chương rỗng không ghi output
    assert (ok / "normalized.txt").read_text("utf-8") == "Hơi thở đều.\nGươm im lặng.\n"
    assert "rỗng" in _final(evs)["summary"]  # summary nêu chương cần duyệt


def test_normalize_without_input_is_permanent(tmp_path, capsys):
    rc = actions.execute_job("normalize", {}, _workdir(tmp_path), job_id="t52")
    assert rc == ExitCode.PERMANENT
    assert _final(_events(capsys))["status"] == "failed"


# ---------- rule 【】 T5.5: chỉ đổi ngoặc, không xóa sạch nội dung ----------


def test_normalize_brackets_preserves_content():
    assert normalize_brackets("【Thí Luyện Tháp】 mở ra.") == "(Thí Luyện Tháp) mở ra."
    assert normalize_brackets("【】") == " "  # bracket rỗng: bỏ, để lại 1 space (collapse ở bước sau)
    assert normalize_brackets("một 【x】 hai 【y】") == "một (x) hai (y)"
    # những loại ngoặc khác không bị đụng vào
    assert normalize_brackets("«giữ» (existing) [cũng vậy]") == "«giữ» (existing) [cũng vậy]"


def test_bracketed_story_text_survives_normalize_stage(tmp_path, capsys):
    wd = _workdir(tmp_path)
    seed = wd / "chapters" / "0003"
    seed.mkdir(parents=True)
    (seed / "text.txt").write_text(
        "Chương 3\n\n【Thí Luyện Tháp】 hiện ra. \n Nhiên Dạ  bước vào【】rỗng.\n",
        encoding="utf-8",
    )
    rc = actions.execute_job(
        "normalize", {"replacements": {"Nhiên Dạ": "Nhiên Khanh"}}, wd, job_id="t52"
    )
    assert rc == ExitCode.SUCCESS
    norm = (seed / "normalized.txt").read_text(encoding="utf-8")
    assert "【" not in norm and "】" not in norm
    assert "(Thí Luyện Tháp) hiện ra." in norm  # nội dung CÂU CHUYỆN trong ngoặc còn nguyên
    assert "Nhiên Khanh bước vào rỗng." in norm  # canon đổi tên + bracket rỗng bỏ


# ---------- T5.5: tài sản glossary/replace dùng được (chỉnh tay được ở repo) ----------


def test_data_assets_stored_and_parse():
    root = pathlib.Path(__file__).resolve().parents[3]  # repo root
    reps = load_replacements(root / "data" / "replace.json")
    assert reps  # replace.json có ít nhất 1 bản ghi
    gloss: dict = load_replacements(root / "data" / "glossary.json")
    assert gloss  # glossary.json parse được thành dict, không rỗng
    assert all(isinstance(v, str) and v.strip() for v in gloss.values())


def test_other_stages_still_permanent():
    assert actions.execute_job(
        "tts", {}, pathlib.Path("."), job_id="t52"
    ) == ExitCode.PERMANENT
