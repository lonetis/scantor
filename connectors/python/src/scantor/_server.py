"""`python -m scantor.serve <entry>`: one connector process (SCANTOR_CONNECTOR_CMD)."""

import fcntl
import os
import sys
from collections.abc import Callable, Mapping
from typing import Any

from scantor._connector import Connector, is_request_id
from scantor._entry import DefinitionKind, LoadedEntry, exit_process
from scantor._entry import load_entry as _load_entry
from scantor._handlers import handle_describe, handle_run, handle_schedule
from scantor.task import Task

NO_FDS_MESSAGE = 'scantor: this program is a scantor task connector; run it with "scantor dev run"'
EXIT_HANDSHAKE_FAILED = 1
EXIT_NO_FDS = 2
TASK_DEFINITION = DefinitionKind(attribute="task", expected=Task, constructor="scantor.Task", failure_type="taskError")

Handler = Callable[[Connector, Task[Any, Any, Any, Any], Mapping[str, Any]], None]
HANDLERS: dict[str, Handler] = {"describe": handle_describe, "run": handle_run, "schedule": handle_schedule}

__all__ = ["HANDLERS", "exit_process", "load_entry", "main", "serve"]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    in_fd = _fd_from_env("SCANTOR_PROTOCOL_IN_FD", 3)
    out_fd = _fd_from_env("SCANTOR_PROTOCOL_OUT_FD", 4)
    if not (_has_access(in_fd, writable=False) and _has_access(out_fd, writable=True)):
        print(NO_FDS_MESSAGE, file=sys.stderr)
        return EXIT_NO_FDS
    if len(args) != 1:
        print("usage: python -m scantor.serve <entry>", file=sys.stderr)
        return EXIT_NO_FDS

    connector = Connector.open(in_fd, out_fd)
    connector.start_reader()
    exit_code = connector.handshake()
    if exit_code is not None:
        return exit_code
    loaded = load_entry(args[0])
    if not isinstance(loaded, Task):
        connector.send({"type": "error", "id": "hello", "error": loaded})
        return EXIT_HANDSHAKE_FAILED
    connector.send({"type": "ready", "id": "hello"})
    try:
        return serve(connector, loaded)
    finally:
        connector.close()


def serve(connector: Connector, task: Task[Any, Any, Any, Any]) -> int:
    """Serve requests one at a time until `shutdown` or the end of the input."""
    while True:
        message = connector.next_request()
        if message is None:
            return 0
        kind = message.get("type")
        if kind == "shutdown":
            return 0
        request_id = message.get("id")
        if not is_request_id(request_id):
            connector.log_internal("warning", f"ignoring a {kind!r} message without a valid id")
            continue
        assert isinstance(request_id, str)
        handler = HANDLERS.get(kind) if isinstance(kind, str) else None
        if handler is None:
            connector.reply_error(request_id, {"type": "validation", "message": f"unsupported request {kind}"})
            continue
        try:
            handler(connector, task, message)
        except OSError:
            raise
        except Exception as exc:
            connector.internal_error(request_id, exc)


def load_entry(entry: str) -> Task[Any, Any, Any, Any] | dict[str, Any]:
    """Import the entry and return its `task`, or the handshake error object."""
    loaded = _load_entry(entry, TASK_DEFINITION)
    return loaded.definition if isinstance(loaded, LoadedEntry) else loaded


def _fd_from_env(name: str, default: int) -> int:
    value = os.environ.get(name, "")
    return int(value) if value.isdigit() else default


def _has_access(fd: int, *, writable: bool) -> bool:
    try:
        mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
    except OSError:
        return False
    return mode in {os.O_RDWR, os.O_WRONLY if writable else os.O_RDONLY}
