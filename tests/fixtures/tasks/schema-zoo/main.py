"""schema-zoo: one task config field per construct of the supported JSON Schema subset (docs/tasks.md §6.4).

The forms, the validation on both sides, secret masking and uploads are tested against it. `run` echoes the
config with the secret replaced by its SHA-256, proving that the task received the plaintext.
"""

import hashlib
from typing import Annotated, Literal

from pydantic import BaseModel, Field, SecretStr

import scantor


class Address(scantor.Config):
    street: str = Field(default="", max_length=100, description="A nested object.")
    zip: str = Field(default="00000", pattern=r"^[0-9]{5}$")


class ByEmail(scantor.Config):
    kind: Literal["email"] = "email"
    to: str = Field(default="ops@example.com", json_schema_extra={"format": "email"})


class ByWebhook(scantor.Config):
    kind: Literal["webhook"] = "webhook"
    url: str = Field(default="https://example.com/hook", json_schema_extra={"format": "uri"})
    retries: int = Field(default=3, ge=0, le=10)


class TaskConfig(scantor.Config):
    text: str = Field(default="hello", min_length=1, max_length=50, title="Text", description="A bounded string.")
    count: int = Field(default=3, ge=1, le=100, description="An integer with bounds.")
    ratio: float = Field(default=0.5, gt=0, lt=1, description="A number with exclusive bounds.")
    step: float = Field(default=0.25, multiple_of=0.25)
    enabled: bool = True
    level: Literal["low", "medium", "high"] = Field(default="medium", description="An enum.")
    note: str | None = Field(default=None, description="A nullable string.")
    tags: list[str] = Field(default=["a"], min_length=0, max_length=5, json_schema_extra={"uniqueItems": True})
    weights: dict[str, int] = Field(default={}, description="A map with integer values.")
    address: Address = Field(default_factory=Address)
    notify: Annotated[ByEmail | ByWebhook, Field(discriminator="kind")] = Field(default_factory=ByEmail)
    api_token: SecretStr | None = Field(default=None, description="A secret (writeOnly).")
    wordlist: str | None = Field(default=None, json_schema_extra={"x-scantor": "upload"}, description="An upload id.")


class Result(BaseModel):
    config: dict[str, object]
    api_token_sha256: str | None
    report: scantor.FileRef


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    token = task_config.api_token.get_secret_value() if task_config.api_token else None
    config = task_config.model_dump(mode="json", exclude={"api_token"})
    report = ctx.files.put("report.txt", f"schema-zoo {task_config.text}\n", "text/plain")
    return Result(
        config=config,
        api_token_sha256=hashlib.sha256(token.encode()).hexdigest() if token is not None else None,
        report=report,
    )


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
