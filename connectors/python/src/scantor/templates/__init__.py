"""Typed proxies of the scan templates (docs/guide/templates.md).

Each module (`single`, `list`, `range`, `repeat`, `tranco`, `crux`, `cidr`) has `ScanConfig`,
`AnalysisConfig` and a `schedule` proxy. Pass the proxy unwrapped (`schedule=tranco.schedule`) to let
the runtime schedule natively, or iterate it inside your own schedule to filter or extend it. Import
modules whose names shadow builtins through the package: `from scantor import templates`, then
`templates.range.schedule`.
"""

from scantor.templates import cidr, crux, list, range, repeat, single, tranco  # noqa: A004

__all__ = ["cidr", "crux", "list", "range", "repeat", "single", "tranco"]

NAMES = ("single", "list", "range", "repeat", "tranco", "crux", "cidr")
