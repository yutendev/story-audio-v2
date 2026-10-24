import subprocess
import sys

import story_audio


def test_package_importable_and_has_version():
    assert story_audio.__version__ == "0.1.0"


def test_cli_help_exits_zero():
    r = subprocess.run(
        [sys.executable, "-m", "story_audio", "--help"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert r.returncode == 0
    assert "story_audio" in r.stdout.lower()
