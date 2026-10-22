from pydantic import BaseModel, SecretStr

import scantor


class TaskConfig(scantor.Config):
    token: SecretStr = SecretStr("default-token")


class Result(BaseModel):
    echoed: SecretStr
    plain: str
    ratio: float


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: TaskConfig) -> Result:
    ratio = float("nan") if task_config.token.get_secret_value() == "nan" else 0.5
    return Result(echoed=task_config.token, plain="visible", ratio=ratio)


task = scantor.Task(task_config=TaskConfig, result=Result, run=run)
