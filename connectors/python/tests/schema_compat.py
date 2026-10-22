"""Comparison of exported schemas with canonical ones (the D5 rule of docs/protocol.md §12.3, plus
every validation keyword, so the proxies' models match `schemas/templates/<name>.json` exactly)."""

from typing import Any

_UNSET = object()

# Keywords that decide which values a property accepts (annotations such as titles are ignored).
ASSERTIONS = frozenset(
    {
        "type",
        "enum",
        "const",
        "format",
        "pattern",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "uniqueItems",
        "items",
        "default",
        "x-scantor",
    }
)


def type_set(schema: dict[str, Any]) -> set[str]:
    """The JSON types a (sub)schema admits, with nullable unions normalised."""
    if "anyOf" in schema:
        return set().union(*(type_set(branch) for branch in schema["anyOf"]))
    declared = schema.get("type")
    if isinstance(declared, list):
        return set(declared)
    if isinstance(declared, str):
        return {declared}
    if "enum" in schema:
        return {_json_type(value) for value in schema["enum"]}
    return set()


def enum_values(schema: dict[str, Any]) -> list[Any] | None:
    if "enum" in schema:
        return sorted(schema["enum"], key=repr)
    for branch in schema.get("anyOf", []):
        values = enum_values(branch)
        if values is not None:
            return values
    return None


def assertions(schema: dict[str, Any]) -> dict[str, Any]:
    """The validation keywords of a property, with a nullable `anyOf` folded into `type: [X, "null"]`."""
    flat = dict(schema)
    branches = flat.pop("anyOf", None)
    if branches is not None:
        others = [branch for branch in branches if branch.get("type") != "null"]
        assert len(branches) == 2, f"not a nullable union: {schema}"
        assert len(others) == 1, f"not a nullable union: {schema}"
        flat.update({key: value for key, value in others[0].items() if key != "type"})
        flat["type"] = ["null", others[0]["type"]]
    result = {key: value for key, value in flat.items() if key in ASSERTIONS}
    if isinstance(result.get("type"), list):
        result["type"] = sorted(result["type"])
    if isinstance(result.get("items"), dict):
        result["items"] = assertions(result["items"])
    return result


def incompatibilities(exported: dict[str, Any], canonical: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if exported.get("additionalProperties") is not False:
        problems.append("root is not closed")
    exported_props = exported.get("properties", {})
    canonical_props = canonical.get("properties", {})
    if set(exported_props) != set(canonical_props):
        problems.append(f"properties {sorted(exported_props)} != {sorted(canonical_props)}")
    if set(exported.get("required", [])) != set(canonical.get("required", [])):
        problems.append(f"required {exported.get('required')} != {canonical.get('required')}")
    for name in set(exported_props) & set(canonical_props):
        mine, theirs = exported_props[name], canonical_props[name]
        if type_set(mine) != type_set(theirs):
            problems.append(f"{name}: types {type_set(mine)} != {type_set(theirs)}")
        if mine.get("default", _UNSET) != theirs.get("default", _UNSET):
            problems.append(f"{name}: default {mine.get('default')!r} != {theirs.get('default')!r}")
        if enum_values(mine) != enum_values(theirs):
            problems.append(f"{name}: enum {enum_values(mine)} != {enum_values(theirs)}")
        if assertions(mine) != assertions(theirs):
            problems.append(f"{name}: keywords {assertions(mine)} != {assertions(theirs)}")
    return problems


def _json_type(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"
