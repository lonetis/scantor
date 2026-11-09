"""`scantor.script.Script`: the typed definition of a script (its config and result types and `run`)."""

import inspect
import json
import typing
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Generic, TypeVar, cast, overload

import pydantic

from scantor._entry import DefinitionKind
from scantor.errors import DefinitionError
from scantor.models import Empty
from scantor.script._context import ScriptContext

CFG = TypeVar("CFG", bound=pydantic.BaseModel, default=Empty)
RES = TypeVar("RES", bound=pydantic.BaseModel, default=pydantic.BaseModel)

Returned = RES | Mapping[str, Any]


class ResultType(typing.Protocol[RES]):
    """A pydantic model class used as the result type (pins the inference of `RES` to `result=`)."""

    def model_copy(self, instance: RES, /) -> RES: ...


class Script(Generic[CFG, RES]):
    """A script definition; assign it to the module-level name `script` of the entry.

    `run(ctx, config)` may be `async`. `config` is the config model (`scantor.Config`; default
    `scantor.Empty`), validated before `run` is called. `result` is the model of what `run` returns,
    stored as the run's result; without it `run` returns None or any JSON value. Secrets do not belong
    in either model: pass them as run secrets and read `ctx.secrets`.
    """

    @overload
    def __init__(
        self,
        *,
        run: Callable[[ScriptContext, CFG], Returned[RES] | Awaitable[Returned[RES]]],
        config: type[CFG] | None = None,
        result: ResultType[RES],
    ) -> None: ...
    @overload
    def __init__(
        self,
        *,
        run: Callable[[ScriptContext, CFG], object],
        config: type[CFG] | None = None,
        result: None = None,
    ) -> None: ...
    def __init__(
        self,
        *,
        run: Callable[[ScriptContext, Any], object],
        config: type[Any] | None = None,
        result: object = None,
    ) -> None:
        if not callable(run):
            raise DefinitionError(f"run must be a function, not {type(run).__name__}")
        config_model = _model_type("config", config) or Empty
        result_model = _model_type("result", result)
        _check_run(run, config_model)
        _check_no_secrets("config", config_model, "validation")
        if result_model is not None:
            _check_no_secrets("result", result_model, "serialization")
        self.run = run
        self.config: type[CFG] = cast(type[CFG], config_model)
        self.result: type[RES] | None = cast(type[RES] | None, result_model)


SCRIPT_DEFINITION = DefinitionKind(
    attribute="script", expected=Script, constructor="scantor.script.Script", failure_type="scriptError"
)


def _model_type(role: str, value: object) -> type[pydantic.BaseModel] | None:
    if value is None:
        return None
    if isinstance(value, type) and issubclass(value, pydantic.BaseModel):
        return value
    raise DefinitionError(f"{role} must be a pydantic model class, not {value!r}")


def _check_no_secrets(
    role: str, model: type[pydantic.BaseModel], mode: typing.Literal["validation", "serialization"]
) -> None:
    try:
        schema = model.model_json_schema(mode=mode)
    except pydantic.PydanticUserError as exc:
        raise DefinitionError(f"the {role} model {model.__name__} has no JSON Schema: {exc}") from exc
    if '"writeOnly": true' in json.dumps(schema):
        raise DefinitionError(
            f"the {role} model {model.__name__} has a secret field (SecretStr, SecretBytes or writeOnly); "
            "scripts store configs and results as given: pass secrets as run secrets and read ctx.secrets"
        )


def _check_run(run: Callable[..., object], config_model: type[pydantic.BaseModel]) -> None:
    """Fail at import when `run` cannot take (ctx, config) or names another config model."""
    try:
        signature = inspect.signature(run)
    except TypeError, ValueError:
        return
    try:
        signature.bind(None, None)
    except TypeError as exc:
        raise DefinitionError(f"run must accept two positional arguments (ctx, config): {exc}") from exc
    try:
        hints = typing.get_type_hints(run)
    except NameError, TypeError, AttributeError:
        return
    parameters = list(signature.parameters.values())
    if len(parameters) < 2:
        return
    annotation = hints.get(parameters[1].name)
    if (
        isinstance(annotation, type)
        and issubclass(annotation, pydantic.BaseModel)
        and not issubclass(config_model, annotation)
    ):
        raise DefinitionError(
            f"run's parameter {parameters[1].name!r} is annotated {annotation.__name__}, but the script's "
            f"config type is {config_model.__name__}; pass config={annotation.__name__} to Script"
        )
