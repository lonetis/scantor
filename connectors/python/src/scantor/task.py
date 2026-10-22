"""`scantor.Task`: the typed definition of a task (its config and result types and functions)."""

import inspect
import typing
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable, Mapping
from typing import Any, Generic, Protocol, TypeVar, cast

import pydantic

from scantor import templates
from scantor.context import Context
from scantor.errors import DefinitionError
from scantor.models import Empty
from scantor.templates._stream import template_name

TC = TypeVar("TC", bound=pydantic.BaseModel, default=Empty)
SC = TypeVar("SC", bound=pydantic.BaseModel, default=Empty)
AC = TypeVar("AC", bound=pydantic.BaseModel, default=Empty)
R = TypeVar("R", bound=pydantic.BaseModel, default=pydantic.BaseModel)


class ResultType(Protocol[R]):
    """A pydantic model class used as the result type.

    `R` appears in an argument and a return position here, which makes the type checker infer the
    result type exactly from `result=` instead of widening it to whatever `run` returns.
    """

    def model_copy(self, instance: R, /) -> R: ...


Returned = R | Mapping[str, Any]
Produced = AC | Mapping[str, Any]


class Task(Generic[TC, SC, AC, R]):
    """A task definition; assign it to the module-level name `task` of the entry.

    `run(ctx, analysis_config, task_config)` returns the result (a model instance or a dict) and may be
    `async`. `schedule(ctx, scan_config, task_config)` yields analysis configs (generator, async
    generator or iterable); omitted, the template `single` creates one analysis. A template proxy passed
    unwrapped (`schedule=tranco.schedule`) runs natively in the runtime and implies the template's own
    scan and analysis config types. Omitted config types default to `scantor.Empty`.
    """

    def __init__(
        self,
        *,
        result: ResultType[R],
        run: Callable[[Context, AC, TC], Returned[R] | Awaitable[Returned[R]]],
        task_config: type[TC] | None = None,
        scan_config: type[SC] | None = None,
        analysis_config: type[AC] | None = None,
        schedule: Callable[[Context, SC, TC], Iterable[Produced[AC]] | AsyncIterable[Produced[AC]]] | None = None,
    ) -> None:
        result_model = _model_type("result", result)
        if result_model is None:
            raise DefinitionError("scantor.Task requires result=<a pydantic model class>")
        if not callable(run):
            raise DefinitionError(f"run must be a function, not {type(run).__name__}")
        if schedule is not None and not callable(schedule):
            raise DefinitionError(f"schedule must be a function, not {type(schedule).__name__}")

        template = template_name(schedule) if schedule is not None else "single"
        task_model = _model_type("task_config", task_config) or Empty
        scan_model = _model_type("scan_config", scan_config)
        analysis_model = _model_type("analysis_config", analysis_config)
        if template is not None:
            module = cast(Any, getattr(templates, template))
            scan_model = _template_type(template, "scan_config", scan_model, module.ScanConfig, schedule)
            if schedule is not None:
                analysis_model = _template_type(
                    template, "analysis_config", analysis_model, module.AnalysisConfig, schedule
                )
        scan_model = scan_model or Empty
        analysis_model = analysis_model or Empty

        _check_function("run", run, ("analysis_config", analysis_model), ("task_config", task_model))
        if schedule is not None and template is None:
            _check_function("schedule", schedule, ("scan_config", scan_model), ("task_config", task_model))

        self.result: type[R] = cast(type[R], result_model)
        self.task_config: type[TC] = cast(type[TC], task_model)
        self.scan_config: type[SC] = cast(type[SC], scan_model)
        self.analysis_config: type[AC] = cast(type[AC], analysis_model)
        self.run = run
        self.schedule: Callable[..., object] = schedule if schedule is not None else templates.single.schedule
        self.template: str | None = template
        """The template whose proxy is the schedule (`single` when omitted), None for a custom schedule."""


def _model_type(role: str, value: object) -> type[pydantic.BaseModel] | None:
    if value is None:
        return None
    if isinstance(value, type) and issubclass(value, pydantic.BaseModel):
        return value
    raise DefinitionError(f"{role} must be a pydantic model class, not {value!r}")


def _template_type(
    template: str,
    role: str,
    given: type[pydantic.BaseModel] | None,
    canonical: type[pydantic.BaseModel],
    schedule: object,
) -> type[pydantic.BaseModel]:
    if given is None or given is canonical:
        return canonical
    if schedule is None:
        raise DefinitionError(
            f"{role}={given.__name__} needs a schedule; without one the task uses the template "
            "single, whose scan config is scantor.Empty"
        )
    raise DefinitionError(
        f"the unwrapped template {template} uses its own types: omit {role} or pass "
        f"templates.{template}.{canonical.__name__}; to add fields, write a schedule that iterates "
        f"templates.{template}.schedule(ctx, scan_config) and yields your own analysis configs"
    )


def _check_function(
    label: str,
    function: Callable[..., object],
    second: tuple[str, type[pydantic.BaseModel]],
    third: tuple[str, type[pydantic.BaseModel]],
) -> None:
    """Fail at import when `function` cannot take (ctx, config, task_config) or names other models.

    These checks are a convenience on top of the type checker: callables whose signature or
    annotations cannot be introspected (builtins, unresolvable forward references) are accepted as is.
    """
    try:
        signature = inspect.signature(function)
    except TypeError, ValueError:
        return
    try:
        signature.bind(None, None, None)
    except TypeError as exc:
        raise DefinitionError(
            f"{label} must accept three positional arguments (ctx, {second[0]}, task_config): {exc}"
        ) from exc
    try:
        hints = typing.get_type_hints(function)
    except NameError, TypeError, AttributeError:
        return
    parameters = list(signature.parameters.values())
    for position, (role, model) in ((1, second), (2, third)):
        if position >= len(parameters):
            return
        annotation = hints.get(parameters[position].name)
        if (
            isinstance(annotation, type)
            and issubclass(annotation, pydantic.BaseModel)
            and not issubclass(model, annotation)
        ):
            raise DefinitionError(
                f"{label}'s parameter {parameters[position].name!r} is annotated "
                f"{annotation.__name__}, but the task's {role} type is {model.__name__}; pass "
                f"{role}={annotation.__name__} to scantor.Task"
            )
