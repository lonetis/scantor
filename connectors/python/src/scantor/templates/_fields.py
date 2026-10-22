"""Field types whose validation matches JSON Schema exactly (no string-to-number coercion)."""

import re
from typing import Annotated

from pydantic import AfterValidator, BeforeValidator, StrictBool, StrictStr
from pydantic_core import PydanticCustomError

MAX_SAFE_INTEGER = 9007199254740991

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _json_number_only(value: object) -> object:
    # JSON Schema "integer" accepts 1 and 1.0 but never "1" or true; pydantic's lax mode would.
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PydanticCustomError("int_type", "Input should be a valid integer")
    return value


def _uuid(value: str) -> str:
    if not _UUID.match(value):
        raise PydanticCustomError("uuid_parsing", "Input should be a valid UUID")
    return value


# Use after the constraints, e.g. Annotated[int, Field(ge=0), JSON_INTEGER], so that pydantic keeps
# them on the integer schema (and in its JSON Schema as minimum/maximum).
JSON_INTEGER = BeforeValidator(_json_number_only)
JsonInt = Annotated[int, JSON_INTEGER]
JsonBool = StrictBool
JsonStr = StrictStr
UuidStr = Annotated[StrictStr, AfterValidator(_uuid)]
