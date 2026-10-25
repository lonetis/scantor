"""Static type check of a task: `python -m scantor.check <entry>` (SCANTOR_CHECK_CMD).

Runs basedpyright over the task folder (the working directory, `/task`) and prints every error as one
line `<file>:<line>:<column>: <message>` with the file relative to the task folder; everything else is
printed in a form that does not match that pattern. Exits 0 without errors and 1 otherwise; an entry
that is not in the image is a single warning with exit 0. A task's own `pyrightconfig.json`, or
`[tool.basedpyright]`/`[tool.pyright]` in its `pyproject.toml`, is honoured; without one the check uses
standard mode.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Any, cast

# The base image installs basedpyright into its own virtualenv, so task requirements cannot replace it.
_TOOL_PATH = Path("/opt/scantor/tools/bin/basedpyright")
_EXCLUDES = ["**/.*", "**/__pycache__", "**/node_modules", "**/.venv"]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m scantor.check <entry>", file=sys.stderr)
        return 2
    root = Path.cwd()
    entry = (root / args[0]).resolve()
    if not entry.is_file():
        # The SCANTOR_CHECK_CMD contract (docs/tasks.md §4.2): an image without the sources is a warning;
        # describe reports an entry that is really missing.
        print(f"warning: {args[0]} is not in the image; type check skipped")
        return 0
    tool = _find_tool()
    if tool is None:
        print("scantor.check: basedpyright is not installed in this image", file=sys.stderr)
        return 1
    config_file = _own_config(root)
    with tempfile.TemporaryDirectory(prefix="scantor-check-") as scratch:
        command = [tool, "--outputjson", "--pythonpath", sys.executable]
        if config_file is None:
            config = Path(scratch) / "pyrightconfig.json"
            config.write_text(json.dumps(_default_config(root, entry)), encoding="utf-8")
            command += ["--project", str(config)]
        completed = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False)
    return report(completed.stdout, completed.stderr, completed.returncode, root, culprit=config_file or args[0])


def report(stdout: str, stderr: str, returncode: int, root: Path, *, culprit: str = "main.py") -> int:
    """Print basedpyright's JSON output in the check format; returns the exit code.

    `culprit` is the file blamed when basedpyright itself fails: the task's type checker configuration,
    or the entry when the task has none.
    """
    for line in stderr.splitlines():
        print(f"basedpyright | {line}")
    try:
        output = cast(dict[str, Any], json.loads(stdout))
    except ValueError:
        output = None
    if output is None or returncode not in (0, 1):
        # Exit codes 2-4 are basedpyright's own failures (fatal error, unusable configuration, invalid
        # arguments); its output is passed through and one error line makes the check fail visibly.
        for line in stdout.splitlines():
            print(f"basedpyright | {line}")
        print(f"{culprit}:1: basedpyright failed with exit code {returncode}; see its output above")
        return 1
    # basedpyright skips a configuration file it cannot parse and checks in its own (stricter) default
    # mode instead; the broken file is an error of the task.
    config_errors = [line.strip() for line in stderr.splitlines() if "could not be parsed" in line]
    for message in config_errors:
        print(f"{culprit}:1: {message}")
    diagnostics = cast(list[dict[str, Any]], output.get("generalDiagnostics", []))
    errors = [diagnostic for diagnostic in diagnostics if diagnostic.get("severity") == "error"]
    # basedpyright exits 1 without errors when the task's configuration fails on warnings
    # (failOnWarnings): those warnings are then the errors of the check.
    failing = errors or (diagnostics if returncode == 1 else [])
    for diagnostic in diagnostics:
        location = _location(diagnostic, root)
        message = " ".join(part.strip() for part in str(diagnostic.get("message", "")).splitlines())
        rule = diagnostic.get("rule")
        if rule:
            message = f"{message} ({rule})"
        if any(diagnostic is item for item in failing):
            print(f"{location}: {message}")
        else:
            print(f"[{diagnostic.get('severity')}] {location.replace(':', ' line ', 1)} {message}")
    summary = cast(dict[str, Any], output.get("summary", {}))
    print(
        f"basedpyright checked {summary.get('filesAnalyzed', 0)} files: {len(errors)} errors, "
        f"{summary.get('warningCount', 0)} warnings"
    )
    if returncode == 1 and not failing:
        print(f"{culprit}:1: basedpyright failed without reporting a diagnostic")
    return 1 if failing or config_errors or returncode == 1 else 0


def _location(diagnostic: dict[str, Any], root: Path) -> str:
    file = Path(str(diagnostic.get("file", "")))
    try:
        relative = file.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        relative = file.as_posix()
    start = cast(dict[str, Any], cast(dict[str, Any], diagnostic.get("range", {})).get("start", {}))
    line = int(start.get("line", 0)) + 1
    column = int(start.get("character", 0)) + 1
    return f"{relative}:{line}:{column}"


def _find_tool() -> str | None:
    if _TOOL_PATH.is_file():
        return str(_TOOL_PATH)
    return shutil.which("basedpyright")


def _own_config(root: Path) -> str | None:
    """The task's own basedpyright configuration file, if it has one."""
    if (root / "pyrightconfig.json").is_file():
        return "pyrightconfig.json"
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return None
    try:
        tool = tomllib.loads(pyproject.read_text(encoding="utf-8")).get("tool", {})
    except tomllib.TOMLDecodeError:
        # An unreadable pyproject.toml is basedpyright's to report; it then fails with a clear message.
        return "pyproject.toml"
    return "pyproject.toml" if "basedpyright" in tool or "pyright" in tool else None


def _default_config(root: Path, entry: Path) -> dict[str, Any]:
    config: dict[str, Any] = {
        "include": [str(root)],
        "exclude": [str(root / pattern) for pattern in _EXCLUDES],
        "typeCheckingMode": "standard",
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
    }
    if entry.parent != root.resolve():
        # The connector imports the entry with its directory first on sys.path.
        config["extraPaths"] = [str(entry.parent)]
    return config


if __name__ == "__main__":
    sys.exit(main())
