"""A config with a secret field: scripts reject it at import (use ctx.secrets)."""

from pydantic import SecretStr

import scantor
from scantor.script import Script, ScriptContext


class Params(scantor.Config):
    token: SecretStr = SecretStr("")


def run(ctx: ScriptContext, config: Params) -> None:
    pass


script = Script(run=run, config=Params)
