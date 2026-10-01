"""Draft a semantic model from introspected tables — a starting point the user then edits."""

import re
from typing import Any

NUMERIC = re.compile(r"int|numeric|decimal|double|real|float|money|hugeint", re.I)
TEMPORAL = re.compile(r"date|time", re.I)
BOOLEAN = re.compile(r"bool", re.I)
DIMENSION_NUMBERS = re.compile(r"(^|_)(year|vintage|month|quarter|week|day|zip|code)$", re.I)


def _label(name: str) -> str:
    return name.replace("_", " ").strip().title()


def suggest_model(tables: list[dict[str, Any]]) -> dict[str, Any]:
    datasets = []
    for table in tables:
        dims, measures, time_dim = [], [{"name": "row_count", "expr": "COUNT(*)", "label": "Row count"}], None
        for col in table["columns"]:
            name, typ = col["name"], col["type"]
            if name == "id" or name.endswith("_id") and NUMERIC.search(typ):
                continue
            if TEMPORAL.search(typ):
                time_dim = time_dim or name
                dims.append({"name": name, "column": name, "type": "date", "label": _label(name)})
            elif NUMERIC.search(typ) and not DIMENSION_NUMBERS.search(name):
                measures.append({"name": f"total_{name}", "expr": f'SUM("{name}")', "label": f"Total {_label(name).lower()}"})
            else:
                kind = "boolean" if BOOLEAN.search(typ) else "number" if NUMERIC.search(typ) else "string"
                dims.append({"name": name, "column": name, "type": kind, "label": _label(name)})
        datasets.append({"name": table["name"], "label": _label(table["name"]), "time_dimension": time_dim,
                         "dimensions": dims, "measures": measures})
    return {"datasets": datasets}
