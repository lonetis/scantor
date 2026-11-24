"""netprobe: what a worker can reach and how it resolves names (sandbox and node resolver tests, docs/security.md).

Mode `connect` tries a TCP connection to every `host:port` of the task config and reports which succeeded; mode
`env` reports the names (never the values) of the process's environment variables; mode `resolve` looks up every
name of `names` with getaddrinfo (the worker's resolver path: /etc/resolv.conf, Docker's embedded DNS, the node
resolver) and asks the container's nameserver for the TXT records of every name of `txt`. Every mode can hold the
analysis for `hold_seconds` before it returns, so a test can look at the running worker.
"""

import os
import secrets
import socket
import struct
import time
from typing import Literal

from pydantic import BaseModel, Field

import scantor

TYPE_TXT = 16
CLASS_IN = 1


class TaskConfig(scantor.Config):
    mode: Literal["connect", "env", "resolve"] = "connect"
    targets: list[str] = Field(default=[], description='host:port pairs, for example ["mongo:27017"].')
    names: list[str] = Field(default=[], description="Names to resolve with getaddrinfo (mode resolve).")
    txt: list[str] = Field(default=[], description="Names whose TXT records to ask the nameserver for (mode resolve).")
    timeout_seconds: float = Field(default=3, gt=0, le=30)
    hold_seconds: float = Field(default=0, ge=0, le=300, description="Seconds to wait before returning.")


class Result(BaseModel):
    reachable: dict[str, bool]
    errors: dict[str, str]
    env: list[str]
    addresses: dict[str, list[str]] = {}
    texts: dict[str, list[str]] = {}


def probe(target: str, timeout: float) -> str | None:
    host, _, port = target.rpartition(":")
    try:
        with socket.create_connection((host.strip("[]"), int(port)), timeout=timeout):
            return None
    except (OSError, ValueError) as exc:
        return f"{type(exc).__name__}: {exc}"


def resolve(name: str) -> list[str]:
    infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
    return sorted({str(info[4][0]) for info in infos})


def nameserver() -> str:
    with open("/etc/resolv.conf", encoding="utf-8") as resolv:
        for line in resolv:
            fields = line.split()
            if len(fields) >= 2 and fields[0] == "nameserver":
                return fields[1]
    raise OSError("no nameserver in /etc/resolv.conf")


def read_name(packet: bytes, offset: int) -> int:
    """Returns the offset after the (possibly compressed) name at `offset`."""
    while True:
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            return offset + 2
        if length == 0:
            return offset + 1
        offset += 1 + length


def query_txt(name: str, timeout: float) -> list[str]:
    """One TXT question over UDP to the container's nameserver; the strings of the answer's TXT records."""
    query_id = secrets.randbits(16)
    question = b"".join(bytes([len(label)]) + label.encode("ascii") for label in name.rstrip(".").split(".")) + b"\x00"
    packet = struct.pack(">HHHHHH", query_id, 0x0100, 1, 0, 0, 0) + question + struct.pack(">HH", TYPE_TXT, CLASS_IN)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.connect((nameserver(), 53))
        sock.send(packet)
        deadline = time.monotonic() + timeout
        while True:
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            reply = sock.recv(4096)
            if len(reply) >= 12 and struct.unpack(">H", reply[:2])[0] == query_id:
                break
    _, flags, qdcount, ancount, _, _ = struct.unpack(">HHHHHH", reply[:12])
    rcode = flags & 0x000F
    if rcode != 0:
        names = {1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}
        raise OSError(f"rcode {names.get(rcode, rcode)}")
    offset = 12
    for _ in range(qdcount):
        offset = read_name(reply, offset) + 4
    texts: list[str] = []
    for _ in range(ancount):
        offset = read_name(reply, offset)
        rtype, _, _, rdlength = struct.unpack(">HHIH", reply[offset : offset + 10])
        offset += 10
        if rtype == TYPE_TXT:
            position = offset
            while position < offset + rdlength:
                length = reply[position]
                texts.append(reply[position + 1 : position + 1 + length].decode("utf-8", "replace"))
                position += 1 + length
        offset += rdlength
    return texts


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    result = Result(reachable={}, errors={}, env=[])
    if task_config.mode == "env":
        result.env = sorted(os.environ)
    elif task_config.mode == "connect":
        for target in task_config.targets:
            error = probe(target, task_config.timeout_seconds)
            result.reachable[target] = error is None
            if error is not None:
                result.errors[target] = error
    else:
        for name in task_config.names:
            try:
                result.addresses[name] = resolve(name)
            except OSError as exc:
                result.errors[name] = f"{type(exc).__name__}: {exc}"
        for name in task_config.txt:
            try:
                result.texts[name] = query_txt(name, task_config.timeout_seconds)
            except (OSError, IndexError, struct.error) as exc:
                result.errors[f"txt:{name}"] = f"{type(exc).__name__}: {exc}"
    time.sleep(task_config.hold_seconds)
    return result


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
