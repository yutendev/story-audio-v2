# story_audio worker — CLI & result contract (T1.2)

Worker chạy như child process của Node API (Master Plan §2). Node chơi vai trò quản trạng thái: spawn, đọc exit code, nhận event (T1.3).

## CLI

```
python -m story_audio run --config FILE --job-id ID --action ACTION --workdir DIR
```

- `--config`: JSON object — job payload (manifest) Node đã validate.
- `--action`: một trong `extract | normalize | rewrite | tts | package`.
- `--workdir`: thư mục làm việc Node cấp — worker **chỉ ghi trong này** (T1.4 sẽ cưỡng chế).

Chạy không subcommand → in help, exit 0.

## Exit codes

| Code | Ý nghĩa | Node phải làm |
|---|---|---|
| 0 | SUCCESS | commit stage, đọc artifacts đã báo |
| 10 | RETRYABLE | lỗi tạm thời — schedule lại sau delay |
| 20 | PERMANENT | payload/path/action sai hoặc lỗi không phân loại — job fail rõ ràng |
| 30 | NEEDS_REVIEW | cần người duyệt → chặn TTS/packaging |
| 40 | QUOTA_WAIT | hết quota free — lưu `notBefore`, đợi (không retry spin) |

Argparse usage error (thiếu tham số/action lạ) trả exit 2.

## Channel

- **stdout**: chỉ event protocol JSONL (T1.3). Hiện tại chưa in gì ra stdout; T1.3 sẽ lắp protocol vào.
- **stderr**: log/thông báo thường.

## Điểm cưỡng chế

- Config file: phải tồn tại, parse được, là JSON object → lệch = 20.
- Workdir: phải là directory tồn tại → lệch = 20.
- Exception chưa phân loại từ stage = 20 (không bao giờ nuốt thành SUCCESS).
- Stage chưa implement (tới Phase 5–7) = 20 + message rõ ràng.
