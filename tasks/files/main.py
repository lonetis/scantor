"""files: store files with each analysis and reference them from the result.

The template `list` (unwrapped) creates one analysis per item. Plain values stay in the result; files
are stored separately and referenced by FileRefs, which may sit anywhere in the result: directly, in a
nested model or in a list.
"""

import json
from pathlib import Path

from pydantic import BaseModel, Field

import scantor
from scantor import templates

PIXEL = Path(__file__).with_name("pixel.png")


class TaskConfig(scantor.Config):
    copies: int = Field(default=2, ge=0, le=10, description="Number of images in the gallery.")


class Attachments(BaseModel):
    data: scantor.FileRef
    image: scantor.FileRef


class Result(BaseModel):
    item: str
    length: int
    data: scantor.FileRef
    image: scantor.FileRef
    notes: scantor.FileRef
    nested: Attachments
    gallery: list[scantor.FileRef]


def run(ctx: scantor.Context, analysis_config: templates.list.AnalysisConfig, task_config: TaskConfig) -> Result:
    item = analysis_config.item
    document = json.dumps({"item": item, "index": analysis_config.index, "upper": item.upper()}, indent=2)
    data = ctx.files.put("data.json", document, "application/json")
    image = ctx.files.put("image.png", PIXEL, "image/png")  # image types are shown inline in the UI

    # A file written to the scratch directory is stored by path; its content is copied at once.
    notes_path = ctx.tmp_dir / "notes.txt"
    notes_path.write_text(f"Notes on {item}\n", encoding="utf-8")
    notes = ctx.files.put("notes.txt", notes_path, "text/plain")

    nested = Attachments(
        data=ctx.files.put("nested.json", json.dumps({"nested": True}), "application/json"),
        image=ctx.files.put("nested.png", PIXEL, "image/png"),
    )
    gallery = [ctx.files.put(f"gallery-{n}.png", PIXEL, "image/png") for n in range(task_config.copies)]
    return Result(item=item, length=len(item), data=data, image=image, notes=notes, nested=nested, gallery=gallery)


task = scantor.Task(task_config=TaskConfig, result=Result, schedule=templates.list.schedule, run=run)
