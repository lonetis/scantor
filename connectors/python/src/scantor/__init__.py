"""scantor Python connector: define a scantor task with typed pydantic models.

A task entry defines a module-level `task = scantor.Task(...)`. See docs/guide/authoring-python.md.
"""

from scantor._version import __version__
from scantor.context import Context, Files, LogLevel
from scantor.errors import DefinitionError, Fatal, Retry, ScantorError
from scantor.models import Config, Empty, FileRef
from scantor.task import AC, SC, TC, R, Task

__all__ = [
    "AC",
    "SC",
    "TC",
    "Config",
    "Context",
    "DefinitionError",
    "Empty",
    "Fatal",
    "FileRef",
    "Files",
    "LogLevel",
    "R",
    "Retry",
    "ScantorError",
    "Task",
    "__version__",
]
