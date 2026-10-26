"""Test kiểm thử file sidecar rewritten.chunks.json, đổi tên backend và phân loại severity."""

from __future__ import annotations

import json
from pathlib import Path

from story_audio import config
from story_audio import paths as P
from story_audio.providers import LLMClient, Provider, ProviderError
from story_audio.rewrite import rewrite_part, rewrite_stage, verify_chunks_sidecar

_NO_SLEEP = lambda _s: None


class DummyEmitter:
    def __init__(self):
        self.events = []

    def send(self, ev_type: str, **payload):
        self.events.append((ev_type, payload))


class ScriptedProvider(Provider):
    name = "scripted"

    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.call_idx = 0

    def complete(self, prompt: str, system: str = "") -> str:
        if self.call_idx < len(self.responses):
            res = self.responses[self.call_idx]
            self.call_idx += 1
            return res
        return self.responses[-1] if self.responses else ""


class ErroringProvider(Provider):
    name = "erroring"

    def complete(self, prompt: str, system: str = "") -> str:
        raise ProviderError("Lỗi kết nối API provider")


def _setup_chapter(workdir: Path, chapter_no: int, text: str):
    d = workdir / "chapters" / f"{chapter_no:04d}"
    d.mkdir(parents=True, exist_ok=True)
    P.atomic_write(d / "normalized.txt", text)
    return d


def test_sidecar_schema_and_verification(tmp_path: Path):
    """Sidecar rewritten.chunks.json được sinh ra đầy đủ schema và pass verify_chunks_sidecar."""
    chapter_dir = _setup_chapter(
        tmp_path,
        1,
        "Chương 1: Khởi Đầu\n\nKhương Vô Ưu đứng trên đỉnh núi cao nhìn về phương xa.\nGió thổi lồng lộng bay tà áo hắn.",
    )
    provider = ScriptedProvider([
        "Khương Vô Ưu đứng trên đỉnh núi cao nhìn về phương xa.\nGió thổi lồng lộng bay tà áo hắn."
    ])
    em = DummyEmitter()

    res_code = rewrite_stage({}, tmp_path, em, providers=[provider], sleep=_NO_SLEEP)
    assert res_code.name in ("SUCCESS", "NEEDS_REVIEW")

    sidecar_file = chapter_dir / "rewritten.chunks.json"
    assert sidecar_file.exists()

    sidecar = json.loads(sidecar_file.read_text(encoding="utf-8"))
    assert sidecar["schema_version"] == "1.0"
    assert sidecar["chapter_no"] == 1
    assert "text_sha256" in sidecar
    assert sidecar["total_chunks"] == 1
    assert sidecar["chapter_status"] == "ok"
    assert "tier_counts" in sidecar
    assert "severity_counts" in sidecar

    chunk0 = sidecar["chunks"][0]
    assert chunk0["index"] == 0
    assert chunk0["tier"] in ("tier1", "tier2")
    assert chunk0["severity"] == "ok"
    assert chunk0["remaining_errors"] == []
    assert chunk0["char_start"] > 0
    assert chunk0["char_end"] > chunk0["char_start"]
    assert len(chunk0["sha256"]) == 64

    # Xác thực hash khớp
    ok, msg = verify_chunks_sidecar(chapter_dir)
    assert ok is True
    assert msg == "OK"


def test_verify_chunks_sidecar_detects_text_tampering(tmp_path: Path):
    """Khi rewritten.txt bị chỉnh sửa trái phép, verify_chunks_sidecar phát hiện hash mismatch."""
    chapter_dir = _setup_chapter(
        tmp_path,
        2,
        "Chương 2: Thử Thách\n\nNội dung chương 2 đầy đủ và trôi chảy không có vấn đề gì.",
    )
    provider = ScriptedProvider([
        "Nội dung chương 2 đầy đủ và trôi chảy không có vấn đề gì."
    ])
    em = DummyEmitter()
    rewrite_stage({}, tmp_path, em, providers=[provider], sleep=_NO_SLEEP)

    # Sửa lén rewritten.txt
    txt_path = chapter_dir / "rewritten.txt"
    original_txt = txt_path.read_text(encoding="utf-8")
    txt_path.write_text(original_txt + "\nChèn thêm dòng gian lận.", encoding="utf-8")

    ok, msg = verify_chunks_sidecar(chapter_dir)
    assert ok is False
    assert "Hash toàn văn bản không khớp" in msg


def test_verify_chunks_sidecar_detects_chunk_slice_tampering(tmp_path: Path):
    """Khi sidecar trỏ char_start/char_end lệch hoặc chunk hash bị sửa, verify phát hiện."""
    chapter_dir = _setup_chapter(
        tmp_path,
        3,
        "Chương 3: Cạm Bẫy\n\nĐoạn văn chương 3 an toàn và nguyên vẹn.",
    )
    provider = ScriptedProvider(["Đoạn văn chương 3 an toàn và nguyên vẹn."])
    em = DummyEmitter()
    rewrite_stage({}, tmp_path, em, providers=[provider], sleep=_NO_SLEEP)

    sidecar_path = chapter_dir / "rewritten.chunks.json"
    data = json.loads(sidecar_path.read_text(encoding="utf-8"))
    # Giả mạo hash của chunk slice
    data["chunks"][0]["sha256"] = "0" * 64
    sidecar_path.write_text(json.dumps(data), encoding="utf-8")

    ok, msg = verify_chunks_sidecar(chapter_dir)
    assert ok is False
    assert "hash không khớp" in msg


def test_backend_renamed_to_best_candidate_and_source_original():
    """Nhánh fallback trả backend='best_candidate', nhánh ProviderError trả backend='source_original'."""
    orig = "Đoạn văn bản gốc có chữ Hán 武 và số 12345 cần dịch chuốt lại."
    glossary = {"chữ Hán": "văn tự"}
    cache = {}

    # 1. Fallback branch (all attempts fail validation due to missing glossary and length)
    faulty_draft = "Một câu dịch quá ngắn bị thiếu."
    provider = ScriptedProvider([faulty_draft, faulty_draft, faulty_draft])
    client = LLMClient([provider], sleep=_NO_SLEEP)

    r_fallback = rewrite_part(orig, glossary, "", client, cache, attempts=3)
    assert r_fallback["tier"] == "fallback"
    assert r_fallback["backend"] == "best_candidate"

    # 2. ProviderError branch
    err_provider = ErroringProvider()
    err_client = LLMClient([err_provider], sleep=_NO_SLEEP)
    r_err = rewrite_part(orig, glossary, "", err_client, cache, attempts=3)
    assert r_err["tier"] == "error"
    assert r_err["backend"] == "source_original"
    assert r_err["text"] == orig


def test_strip_cjk_fallback_records_characters_and_positions():
    """Khi strip_cjk_fallback=True, thông tin ký tự CJK bị xóa được ghi nhận chi tiết."""
    orig = "Đoạn văn bản gốc cần dịch chuốt lại."
    glossary = {}
    cache = {}

    # Draft chứa 2 chữ CJK hiếm không có trong COMMON_CJK_TRANSLIT: 龘 và 靐
    faulty_draft = "Hắn nhìn thấy dị tượng 龘 trên trời và sấm sét 靐 phía xa."
    provider = ScriptedProvider([faulty_draft, faulty_draft, faulty_draft])
    client = LLMClient([provider], sleep=_NO_SLEEP)

    res = rewrite_part(orig, glossary, "", client, cache, attempts=3, strip_cjk_fallback=True)
    assert res["tier"] == "fallback"
    assert res["cjk_stripped"] == 2
    assert len(res["cjk_stripped_chars"]) == 2
    assert res["cjk_stripped_chars"][0]["char"] == "龘"
    assert res["cjk_stripped_chars"][1]["char"] == "靐"
    assert "龘" not in res["text"]
    assert "靐" not in res["text"]


def test_chapter_status_blocked_on_fatal(tmp_path: Path):
    """Chương có chunk fatal (ví dụ ProviderError) được xếp trạng thái chapter_status='blocked'."""
    chapter_dir = _setup_chapter(
        tmp_path,
        4,
        "Chương 4: Lỗi Mạng\n\nNội dung không thể kết nối tới mô hình AI.",
    )
    provider = ErroringProvider()
    em = DummyEmitter()

    rewrite_stage({}, tmp_path, em, providers=[provider], sleep=_NO_SLEEP)

    sidecar = json.loads((chapter_dir / "rewritten.chunks.json").read_text(encoding="utf-8"))
    assert sidecar["chapter_status"] == "blocked"
    assert sidecar["severity_counts"]["fatal"] > 0
    chunk0 = sidecar["chunks"][0]
    assert chunk0["backend"] == "source_original"
    assert chunk0["severity"] == "fatal"


def test_chapter_status_needs_review_when_semantic_ratio_exceeds_threshold(tmp_path: Path):
    """Chương có tỉ lệ chunk semantic vượt MAX_FALLBACK_RATIO (0.20) được xếp 'needs_review'."""
    p1 = "Câu một của đoạn một. Câu hai của đoạn một. Câu ba của đoạn một có tên Khương Vô Ưu. Câu bốn của đoạn một. Câu năm của đoạn một."
    p2 = "Câu một của đoạn hai. Câu hai của đoạn hai. Câu ba của đoạn hai rất ổn. Câu bốn của đoạn hai. Câu năm của đoạn hai."
    chapter_dir = _setup_chapter(
        tmp_path,
        5,
        "Chương 5: Phân Vân\n\n" + p1 + "\n\n" + p2,
    )
    # Đoạn 1 dịch thiếu thuật ngữ Khương Vô Ưu; Đoạn 2 dịch chuẩn khớp bản gốc
    d1 = "Câu một của đoạn một. Câu hai của đoạn một. Câu ba của đoạn một thiếu tên. Câu bốn của đoạn một. Câu năm của đoạn một."
    d2 = p2
    provider = ScriptedProvider([
        d1,  # chunk 1 attempt 1
        d1,  # chunk 1 attempt 2
        d1,  # chunk 1 attempt 3 -> fallback (semantic: thiếu thuật ngữ)
        d2,  # chunk 2 attempt 1 -> pass (tier1, ok)
    ])
    em = DummyEmitter()
    payload = {
        "chunk_max_chars": 200,
        "glossary": {"Khương Vô Ưu": "Khương Vô Ưu"}
    }

    rewrite_stage(payload, tmp_path, em, providers=[provider], sleep=_NO_SLEEP)

    sidecar = json.loads((chapter_dir / "rewritten.chunks.json").read_text(encoding="utf-8"))
    assert sidecar["total_chunks"] == 2
    assert sidecar["severity_counts"]["semantic"] == 1
    assert sidecar["severity_counts"]["ok"] == 1
    assert sidecar["semantic_fallback_ratio"] == 0.5
    assert sidecar["chapter_status"] == "needs_review"
