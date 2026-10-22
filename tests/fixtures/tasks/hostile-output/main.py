"""hostile-output: content that must render inert everywhere (docs/security.md HDR-5).

The result, the logs and the error carry HTML, script and ANSI sequences; the files are HTML, SVG with script,
a PNG and a name with CR, LF and quotes. Mode `fail` raises with the same payload instead of returning.
"""

import base64
from typing import Literal

from pydantic import BaseModel

import scantor

PAYLOAD = "<img src=x onerror=alert(1)><script>alert(2)</script>\x1b[31mred\x1b[0m javascript:alert(3)"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class TaskConfig(scantor.Config):
    mode: Literal["ok", "fail"] = "ok"


class Result(BaseModel):
    html: str
    link: str
    ansi: str
    files: list[scantor.FileRef]


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    ctx.log("warning", PAYLOAD, html="<b>bold</b>")
    print(f"stdout {PAYLOAD}")
    if task_config.mode == "fail":
        raise scantor.Fatal(PAYLOAD)
    files = [
        ctx.files.put("x.html", "<html><body><script>alert(4)</script></body></html>", "text/html"),
        ctx.files.put("x.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(5)</script></svg>', "image/svg+xml"),
        ctx.files.put("x.png", PNG, "image/png"),
        ctx.files.put('bad\r\nname "quoted" \'single\'.txt', "content", "text/plain"),
    ]
    return Result(html=PAYLOAD, link="javascript:alert(6)", ansi="\x1b[1mbold\x1b[0m", files=files)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
