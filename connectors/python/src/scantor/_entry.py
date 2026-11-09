"""Importing an entry file and taking its definition (`task` or `script`); exiting the process.

Shared by the connector (`python -m scantor.serve`) and the script runner (`python -m scantor.script`),
including the script runner's worker processes, which import the entry again under the same module name.
"""

import contextlib
import importlib.util
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scantor._json import MAX_ERROR_MESSAGE, describe_exception, format_stack, truncate
from scantor.errors import DefinitionError

_EXIT_WATCHDOG_SECONDS = 4.0


@dataclass(frozen=True)
class DefinitionKind:
    """What an entry defines: the attribute name, its class and how errors name them."""

    attribute: str
    """module-level name of the definition (`task`, `script`)"""
    expected: type
    constructor: str
    """how users create it, for messages (`scantor.Task`)"""
    failure_type: str
    """error type of an import failure (`taskError`, `scriptError`)"""


@dataclass(frozen=True)
class LoadedEntry:
    definition: Any
    module_name: str
    path: Path


def entry_module_name(path: Path) -> str:
    """The module name an entry is imported under: its stem, unless a module of that name is loaded."""
    return path.stem if path.stem not in sys.modules else f"__scantor_entry_{path.stem}"


def load_entry(entry: str, kind: DefinitionKind, module_name: str | None = None) -> LoadedEntry | dict[str, Any]:
    """Import the entry and return its definition, or a protocol error object (`type`, `message`, `stack`).

    The entry's directory goes first on `sys.path`, so sibling modules (`models.py`) import as top-level
    modules. `module_name` re-imports an entry under the name another process used.
    """
    path = Path(entry) if os.path.isabs(entry) else Path.cwd() / entry
    if not path.is_file():
        return {"type": "validation", "message": f"entry {entry} does not exist or is not a file"}
    sys.path.insert(0, str(path.parent))
    name = module_name or entry_module_name(path)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return {"type": "validation", "message": f"entry {entry} cannot be imported as a Python module"}
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except DefinitionError as exc:
        return {
            "type": "validation",
            "message": truncate(f"invalid {kind.attribute} definition: {exc}", MAX_ERROR_MESSAGE),
            "stack": format_stack(exc),
        }
    except (Exception, SystemExit) as exc:
        return {"type": kind.failure_type, "message": describe_exception(exc), "stack": format_stack(exc)}
    definition = getattr(module, kind.attribute, None)
    if definition is None:
        return {
            "type": "validation",
            "message": (
                f"{path.name} defines no module-level `{kind.attribute}`; "
                f"assign {kind.attribute} = {kind.constructor}(...)"
            ),
        }
    if not isinstance(definition, kind.expected):
        return {
            "type": "validation",
            "message": f"`{kind.attribute}` in {path.name} is a {type(definition).__name__}, not a {kind.constructor}",
        }
    return LoadedEntry(definition=definition, module_name=name, path=path)


def exit_process(code: int) -> None:
    """Exit with `code`, even when threads started by user code would keep the interpreter alive."""
    for stream in (sys.stdout, sys.stderr):
        # A closed or broken stdout/stderr must not keep the process from exiting.
        with contextlib.suppress(OSError, ValueError):
            stream.flush()
    watchdog = threading.Timer(_EXIT_WATCHDOG_SECONDS, os._exit, (code,))
    watchdog.daemon = True
    watchdog.start()
    sys.exit(code)
