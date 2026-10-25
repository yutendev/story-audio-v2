import json
from pathlib import Path
from story_audio.normalize import auto_sanitize_cjk, split_raw, split_sentences
from story_audio.rewrite import (
    chunk_text,
    glossary_subset,
    load_glossary,
    rewrite_part,
)
from story_audio.providers import LLMClient, Provider
from story_audio.qa import qa_check

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

    for ch in chapters:
        raw_file = nguon_dir / f"{ch}.txt"
        raw_text = raw_file.read_text(encoding="utf-8")
        
        # 1. Normalize
        sanitized = auto_sanitize_cjk(raw_text)
        title, paras = split_raw(sanitized)
        chunks = chunk_text([title] + paras)

        # Chuẩn bị draft từ viet_lai cũ tương ứng
        rewr_old = (viet_lai_dir / f"{ch}.txt").read_text(encoding="utf-8")
        t_old, p_old = split_raw(rewr_old)
        old_chunks = chunk_text([t_old] + p_old)

        provider = DraftLegacyProvider()
        client = LLMClient([provider])
        cache = {}

        tier_counts = {"tier1": 0, "tier2": 0, "tier3": 0, "fallback": 0}
        total_calls = 0
        rewritten_parts = []
        prev_tail = ""

        for idx, chunk in enumerate(chunks):
            # Cung cấp draft cũ tương ứng cho lượt gọi này (không nhảy sang chunk khác khi retry)
            old_idx = min(int(idx * len(old_chunks) / len(chunks)), len(old_chunks) - 1)
            provider.set_current_draft(old_chunks[old_idx])
            subset = glossary_subset(chunk, glossary)
            res = rewrite_part(chunk, subset, prev_tail, client, cache, attempts=3)
            
            t = res["tier"]
            tier_counts[t] = tier_counts.get(t, 0) + 1
            total_calls += res["calls"]
            rewritten_parts.append(res["text"])
            
            # Cập nhật prev_tail
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
