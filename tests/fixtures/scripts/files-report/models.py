"""The result model of the example task `files` (tasks/files/main.py), copied unchanged.

A script reads results typed with the task's own model: copy the model classes the result uses.
"""

from pydantic import BaseModel

import scantor


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
