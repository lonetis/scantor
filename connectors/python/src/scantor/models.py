"""Base models of the definition API: config bases and the file reference type."""

import pydantic


class Config(pydantic.BaseModel):
    """Base class of task, scan and analysis configs.

    Unknown keys are rejected, so a typo such as `limt: 100` fails at scan start instead of silently
    running the default. Give every field a default so that `{}` is a valid config.
    """

    model_config = pydantic.ConfigDict(extra="forbid")


class Empty(Config):
    """No parameters."""


class FileRef(pydantic.BaseModel):
    """Reference to a file stored with an analysis, returned by `ctx.files.put`.

    Results may contain FileRefs directly, nested or in lists; the UI renders them as download links.
    The attribute `content_type` is serialised as `contentType`.
    """

    model_config = pydantic.ConfigDict(
        frozen=True,
        extra="forbid",
        serialize_by_alias=True,
        json_schema_extra={"x-scantor": "file"},
    )

    id: str
    name: str
    size: int
    sha256: str
    content_type: str = pydantic.Field(
        validation_alias=pydantic.AliasChoices("contentType", "content_type"),
        serialization_alias="contentType",
    )
