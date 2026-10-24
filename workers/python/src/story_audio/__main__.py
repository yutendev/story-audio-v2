"""CLI entry của worker — contract T1.2.

Usage:
    python -m story_audio run --config FILE --job-id ID --action ACTION --workdir DIR

Exit codes (exit_codes.py): 0 success · 10 retryable · 20 permanent
(mọi lỗi payload/paths/hành động sai thuộc lớp này) · 30 needs_review · 40 quota_wait.
Argparse trả 2 cho usage error (thiếu arg/tham số sai cú pháp).

stdout giữ cho event protocol (T1.3); mọi log/thông báo đi stderr.
T1.3 sẽ thay print thông thường bằng JSONL và chuyển log sang stderr bền bỉ.
"""

import argparse
import json
import sys
from pathlib import Path

from story_audio import actions
from story_audio.exit_codes import ExitCode


def build_parser():
    p = argparse.ArgumentParser(
        prog="story_audio",
        description="Story Audio Python worker — chạy bởi Node với manifest/job config.",
    )
    sub = p.add_subparsers(dest="command")

    run = sub.add_parser("run", help="thực thi một job")
    run.add_argument("--config", required=True, metavar="FILE", help="job payload/config (JSON)")
    run.add_argument("--job-id", required=True, metavar="ID", help="id job từ Node API")
    run.add_argument("--action", required=True, choices=sorted(actions.ACTIONS), help="stage cần chạy")
    run.add_argument("--workdir", required=True, metavar="DIR", help="thư mục làm việc được Node cấp")
    return p


def _emit(message):
    print(message, file=sys.stderr)


def run_job(args):
    config_path = Path(args.config)
    if not config_path.is_file():
        _emit(f"config không tồn tại: {args.config}")
        return ExitCode.PERMANENT
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        _emit(f"config không parse được JSON: {e}")
        return ExitCode.PERMANENT
    if not isinstance(payload, dict):
        _emit("config phải là JSON object")
        return ExitCode.PERMANENT

    workdir = Path(args.workdir)
    if not workdir.is_dir():
        _emit(f"workdir không tồn tại/không phải thư mục: {args.workdir}")
        return ExitCode.PERMANENT

    try:
        return actions.execute_job(args.action, payload, workdir, job_id=args.job_id)
    except Exception as e:  # noqa - trust boundary: mọi exception chưa phân loại = permanent
        _emit(f"job lỗi không phân loại: {type(e).__name__}: {e}")
        return ExitCode.PERMANENT


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return int(run_job(args))


if __name__ == "__main__":
    raise SystemExit(main())
