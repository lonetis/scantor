"""docs/guide/authoring-python.md: its code comes from the real examples and the scaffold.

`<!-- scantor:include <path> -->` blocks must equal the file; `<!-- scantor:excerpt <path> -->` blocks
must consist of lines of the file, in order (`...` elides lines). Every Python block must parse.
"""

import ast
import re
import textwrap

from scantor import templates
from tests.harness import REPO_ROOT

GUIDE = REPO_ROOT / "docs" / "guide" / "authoring-python.md"
MARKED_BLOCK = re.compile(r"<!-- scantor:(include|excerpt) (\S+) -->\n```\w*\n(.*?)```\n", re.DOTALL)
PYTHON_BLOCK = re.compile(r"```python\n(.*?)```\n", re.DOTALL)
ELISION = {"...", "…"}


def _guide() -> str:
    return GUIDE.read_text(encoding="utf-8")


def test_included_files_match() -> None:
    blocks = [match for match in MARKED_BLOCK.finditer(_guide()) if match[1] == "include"]
    assert blocks
    for match in blocks:
        assert match[3] == (REPO_ROOT / match[2]).read_text(encoding="utf-8"), f"{match[2]} differs from the guide"
    assert _guide().count("<!-- scantor:include ") == _guide().count("<!-- scantor:include:end -->")


def test_excerpts_are_lines_of_their_files() -> None:
    blocks = [match for match in MARKED_BLOCK.finditer(_guide()) if match[1] == "excerpt"]
    assert blocks
    for match in blocks:
        source = [line.rstrip() for line in (REPO_ROOT / match[2]).read_text(encoding="utf-8").splitlines()]
        position = 0
        for line in match[3].splitlines():
            if not line.strip() or line.strip() in ELISION:
                continue
            assert line.rstrip() in source[position:], f"{match[2]}: {line!r} is not in the file (in order)"
            position = source.index(line.rstrip(), position) + 1


def test_python_blocks_parse() -> None:
    flags = ast.PyCF_ONLY_AST | ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    for match in PYTHON_BLOCK.finditer(_guide()):
        compile(textwrap.dedent(match[1]), str(GUIDE), "exec", flags=flags)


def test_every_template_is_listed() -> None:
    rows = set(re.findall(r"^\| `(\w+)` \| `templates\.\1` \|", _guide(), flags=re.MULTILINE))
    assert rows == set(templates.NAMES)


def test_example_links_exist() -> None:
    for target in re.findall(r"\]\((\.\./\.\./tasks/[\w-]+)\)", _guide()):
        assert (GUIDE.parent / target).is_dir(), target
