"""Script thử nghiệm offline pipeline rewrite trên 6 chương mẫu (2845-2850).

HẠN CHẾ CỐ HỮU CỦA PHƯƠNG PHÁP GHÉP DRAFT CŨ (TRIAL MOCK):
1. Phương pháp ghép theo nội dung (keyword & entity overlap) trên bản dịch cũ chỉ là
   giải pháp xấp xỉ dùng để kiểm thử cơ chế điều phối và tự sửa lỗi của pipeline trong môi trường offline.
2. Bản dịch cũ (Audio/viet_lai/) vốn được sinh ra từ các part 1800 ký tự của viet_lai.py cũ,
   bị dịch giả cắt xén, dịch thoát ý hoặc dịch nhầm tên nhân vật (ví dụ 2848 dịch nhầm 'Khương Không Lo'
   thành 'Khương Vô Lượng').
3. Do đó, các chỉ số đạt hay fallback trên tập draft cũ KHÔNG phản ánh chất lượng thực tế
   của model LLM thật (Gemini/OpenRouter), mà chỉ chứng minh pipeline vận hành thông suốt và QA Gate
   phát hiện đúng các sai lệch.
"""

import json
import re
import sys
from pathlib import Path

# Đảm bảo stdout UTF-8 trên Windows console
import story_audio.events  # noqa: F401
from story_audio.normalize import auto_sanitize_cjk, split_raw, split_sentences
from story_audio.rewrite import (
    chunk_text,
    glossary_subset,
    load_glossary,
    rewrite_part,
)
from story_audio.providers import LLMClient, Provider
from story_audio.qa import qa_check


def extract_content_keywords(text: str) -> set[str]:
    """Trích xuất thực thể, tên riêng và số liệu làm chữ ký nội dung để ghép đoạn."""
    return set(re.findall(r"[A-ZÀ-Ỹ][a-zà-ỹ]+|\b\d+\b", text))


def find_best_matching_draft(
    chunk: str, old_chunks: list[str], expected_idx: int, window: int = 4
) -> str:
    """Ghép đoạn draft cũ tương ứng dựa trên độ tương đồng nội dung (entity/keyword overlap).
    Tìm kiếm trong cửa sổ lân cận [expected_idx - window .. expected_idx + window] để
    tránh hiện tượng trôi lệch index khi số lượng chunk giữa hai bản khác nhau."""
    if not old_chunks:
        return chunk

    kw_chunk = extract_content_keywords(chunk)
    if not kw_chunk:
        safe_idx = min(max(0, expected_idx), len(old_chunks) - 1)
        return old_chunks[safe_idx]

    start = max(0, expected_idx - window)
    end = min(len(old_chunks), expected_idx + window + 1)

    best_idx = min(max(0, expected_idx), len(old_chunks) - 1)
    best_score = -1

    for j in range(start, end):
        kw_old = extract_content_keywords(old_chunks[j])
        overlap = len(kw_chunk & kw_old)
        if overlap > best_score:
            best_score = overlap
            best_idx = j

    return old_chunks[best_idx]


class DraftLegacyProvider(Provider):
    """Provider trả về bản dịch draft tương ứng với đúng chunk nguồn được gán.
    Tuyệt đối không tự tăng index khi retry để không trả nội dung của chunk khác."""
    name = "draft_legacy"

    def __init__(self):
        self.current_draft = ""

    def set_current_draft(self, draft: str):
        self.current_draft = draft

    def complete(self, prompt: str, system: str = "") -> str:
        # Nếu đang ở chế độ tách câu (Mức 3): trả về các câu từ đúng draft này phân cách bằng \n
        if "chế độ câu (Mức 3)" in prompt:
            sentences = [s.strip() for s in split_sentences(self.current_draft) if s.strip()]
            return "\n".join(sentences)
        return self.current_draft


def run_trial():
    nguon_dir = Path("Audio/nguon/xich-tam-tuan-thien")
    viet_lai_dir = Path("Audio/viet_lai/xich-tam-tuan-thien")
    out_dir = Path("work/trial_2845_2850")
    out_dir.mkdir(parents=True, exist_ok=True)
    glossary = load_glossary("data/glossary.json")

    chapters = ["2845", "2846", "2847", "2848", "2849", "2850"]
    summary = {}

    print("=== ĐỐI CHIẾU SỐ LƯỢNG CHUNK (NGUỒN MỚI VS DRAFT CŨ) ===")
    for ch in chapters:
        raw_file = nguon_dir / f"{ch}.txt"
        raw_text = raw_file.read_text(encoding="utf-8")
        sanitized = auto_sanitize_cjk(raw_text)
        title, paras = split_raw(sanitized)
        chunks = chunk_text([title] + paras)

        rewr_old = (viet_lai_dir / f"{ch}.txt").read_text(encoding="utf-8")
        t_old, p_old = split_raw(rewr_old)
        old_chunks = chunk_text([t_old] + p_old)

        print(
            f"Chương {ch}: mới (nguồn) = {len(chunks)} chunks, "
            f"cũ (draft) = {len(old_chunks)} chunks, lệch = {len(chunks) - len(old_chunks)}"
        )

        provider = DraftLegacyProvider()
        client = LLMClient([provider])
        cache = {}

        tier_counts = {"tier1": 0, "tier2": 0, "tier3": 0, "fallback": 0}
        total_calls = 0
        rewritten_parts = []
        prev_tail = ""

        for idx, chunk in enumerate(chunks):
            # Ghép draft cũ tương ứng theo nội dung thực thể/từ khóa
            expected_idx = int(idx * len(old_chunks) / len(chunks))
            matched_draft = find_best_matching_draft(chunk, old_chunks, expected_idx)
            provider.set_current_draft(matched_draft)

            subset = glossary_subset(chunk, glossary)
            res = rewrite_part(chunk, subset, prev_tail, client, cache, attempts=3)

            t = res["tier"]
            tier_counts[t] = tier_counts.get(t, 0) + 1
            total_calls += res["calls"]
            rewritten_parts.append(res["text"])

            lines = res["text"].strip().split("\n")
            prev_tail = lines[-1] if lines else ""

        full_rewritten = "\n\n".join(rewritten_parts)
        out_file = out_dir / f"{ch}.txt"
        out_file.write_text(full_rewritten, encoding="utf-8")

        # QA Gate
        qa_probs = qa_check(full_rewritten, raw_text, glossary)
        summary[ch] = {
            "total_chunks": len(chunks),
            "tier_counts": tier_counts,
            "total_calls": total_calls,
            "qa_passed": len(qa_probs) == 0,
            "qa_problems": qa_probs,
        }

    return summary

if __name__ == "__main__":
    res = run_trial()
    print(json.dumps(res, ensure_ascii=False, indent=2))
