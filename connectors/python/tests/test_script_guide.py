"""docs/guide/scripts.md: its code comes from the files-report fixture script, and it covers the whole API.

`<!-- scantor:excerpt <path> -->` blocks must consist of lines of the file, in order (`...` elides lines).
Every Python block must parse. Every public member of `ScriptContext` and every file helper of
`Analysis` is documented.
"""

import ast
import inspect
import re
import textwrap

from scantor.script import Analysis, ScriptContext
from tests.harness import REPO_ROOT

GUIDE = REPO_ROOT / "docs" / "guide" / "scripts.md"
EXCERPT = re.compile(r"<!-- scantor:excerpt (\S+) -->\n```\w*\n(.*?)```\n", re.DOTALL)
PYTHON_BLOCK = re.compile(r"```python\n(.*?)```\n", re.DOTALL)
ELISION = {"...", "…"}


def _guide() -> str:
    return GUIDE.read_text(encoding="utf-8")


def test_excerpts_are_lines_of_their_files() -> None:
    blocks = list(EXCERPT.finditer(_guide()))
    assert {match[1] for match in blocks} >= {
        "tests/fixtures/scripts/files-report/main.py",
        "tests/fixtures/scripts/files-report/models.py",
    }
    for match in blocks:
        source = [line.rstrip() for line in (REPO_ROOT / match[1]).read_text(encoding="utf-8").splitlines()]
        position = 0
        for line in match[2].splitlines():
            if not line.strip() or line.strip() in ELISION:
                continue
            assert line.rstrip() in source[position:], f"{match[1]}: {line!r} is not in the file (in order)"
            position = source.index(line.rstrip(), position) + 1


def test_python_blocks_parse() -> None:
    blocks = PYTHON_BLOCK.findall(_guide())
    assert blocks
    for block in blocks:
        ast.parse(textwrap.dedent(block))


def test_every_context_member_is_documented() -> None:
    guide = _guide()
    members = [name for name in vars(ScriptContext) if not name.startswith("_")]
    attributes = re.findall(r"self\.([a-z][a-z_]*)(?::[^=]+)? =", inspect.getsource(ScriptContext.__init__))
    missing = [name for name in [*members, *attributes] if f"ctx.{name}" not in guide]
    assert missing == []


def test_every_file_helper_is_documented() -> None:
    guide = _guide()
    helpers = ["file", "read_bytes", "read_text", "read_json", "open", "download"]
    assert all(callable(getattr(Analysis, name)) for name in helpers)
    assert [name for name in helpers if f"analysis.{name}(" not in guide] == []


def test_map_arguments_are_documented() -> None:
    parameters = inspect.signature(ScriptContext.map).parameters
    keywords = [name for name, parameter in parameters.items() if parameter.kind is inspect.Parameter.KEYWORD_ONLY]
    table = _guide().split("## Parallelism", 1)[1].split("\n## ", 1)[0]
    assert [name for name in keywords if f"`{name}=" not in table] == []
