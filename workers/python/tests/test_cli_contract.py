import argparse
import json
import subprocess
import sys
from pathlib import Path

import pytest

from story_audio import actions
from story_audio.__main__ import main, run_job
from story_audio.exit_codes import ExitCode

VALID_CONFIG = {"job_id": "j1", "source_url": "https://example.invalid/truyen/chuong-1", "config": {}}


@pytest.fixture
def env(tmp_path):
    cfg = tmp_path / "job.json"
    cfg.write_text(json.dumps(VALID_CONFIG), encoding="utf-8")
    wd = tmp_path / "workdir"
    wd.mkdir()
    return {"config": cfg, "workdir": wd, "tmp": tmp_path}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "story_audio", *args], capture_output=True, text=True, encoding="utf-8"
    )


def argv(env_args):
    return ["run", "--config", str(env_args["config"]), "--job-id", "j1", "--action", "extract",
            "--workdir", str(env_args["workdir"])]


def test_valid_args_but_action_not_implemented_is_permanent(env):
    assert main(argv(env)) == int(ExitCode.PERMANENT)


def test_builtin_actions_are_the_documented_set():
    # T7.5 mở rộng registry CLI: package (T7.3) + yt_export (T7.5)
    assert actions.ACTIONS == frozenset(
        {"extract", "normalize", "rewrite", "tts", "package", "yt_export"}
    )


def test_missing_config_is_permanent(env):
    rc = main(["run", "--config", str(env["tmp"] / "khong-ton-tai.json"), "--job-id", "j",
               "--action", "extract", "--workdir", str(env["workdir"])])
    assert rc == int(ExitCode.PERMANENT)


def test_invalid_json_config_is_permanent(env):
    bad = env["tmp"] / "bad.json"
    bad.write_text("{{không phải json", encoding="utf-8")
    rc = main(["run", "--config", str(bad), "--job-id", "j", "--action", "extract",
               "--workdir", str(env["workdir"])])
    assert rc == int(ExitCode.PERMANENT)


def test_non_object_config_is_permanent(env):
    bad = env["tmp"] / "arr.json"
    bad.write_text("[1]", encoding="utf-8")
    assert main(["run", "--config", str(bad), "--job-id", "j", "--action", "extract",
                 "--workdir", str(env["workdir"])]) == int(ExitCode.PERMANENT)


def test_invalid_workdir_is_permanent(env):
    rc = main(["run", "--config", str(env["config"]), "--job-id", "j", "--action", "extract",
               "--workdir", str(env["tmp"] / "khong-ton-tai")])
    assert rc == int(ExitCode.PERMANENT)


def test_unknown_action_rejected_by_argparse_match(env, capsys):
    r = run_cli("run", "--config", str(env["config"]), "--job-id", "j", "--action", "crawl",
                "--workdir", str(env["workdir"]))
    assert r.returncode == 2  # usage error


def test_no_subcommand_prints_help_and_exits_zero(capsys):
    assert main([]) == 0
    assert "story_audio" in capsys.readouterr().out.lower()


def test_unclassified_exception_maps_to_permanent(env, monkeypatch, capsys):
    def boom(action, payload, workdir, job_id=""):
        raise RuntimeError("giả lập lỗi không phân loại")

    monkeypatch.setattr(actions, "execute_job", boom)
    rc = run_job(
        argparse.Namespace(
            command="run", config=str(env["config"]), job_id="j", action="extract",
            workdir=str(env["workdir"]),
        )
    )
    assert rc == int(ExitCode.PERMANENT)
    assert "không phân loại" in capsys.readouterr().err


@pytest.mark.parametrize("code", [ExitCode.RETRYABLE, ExitCode.NEEDS_REVIEW, ExitCode.QUOTA_WAIT])
def test_executed_codes_pass_through_unchanged(env, monkeypatch, capsys, code):
    def fake_success(action, payload, workdir, job_id=""):
        return code

    monkeypatch.setattr(actions, "execute_job", fake_success)
    rc = run_job(
        argparse.Namespace(
            command="run", config=str(env["config"]), job_id="j", action="extract",
            workdir=str(env["workdir"]),
        )
    )
    assert rc == int(code)


def test_all_exit_codes_distinct():
    values = [c.value for c in ExitCode]
    assert len(values) == len(set(values))
