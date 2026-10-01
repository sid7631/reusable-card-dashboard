"""Period presets used as dashboard filter defaults. Mirrors apps/web/src/components/PeriodSelect.tsx."""

from datetime import date

DEMO_TODAY = date(2026, 6, 11)  # the demo data ends here


def preset_window(preset: str | None) -> tuple[str | None, str | None]:
    if not preset or preset == "ytd":
        return f"{DEMO_TODAY.year}-01-01", DEMO_TODAY.isoformat()
    if preset == "all":
        return None, None
    if preset.startswith("FY '"):
        year = 2000 + int(preset[4:6])
        return f"{year}-01-01", f"{year}-12-31"
    if preset.startswith("Q") and " '" in preset:
        q, year = int(preset[1]), 2000 + int(preset[-2:])
        ends = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}
        return f"{year}-{(q - 1) * 3 + 1:02d}-01", f"{year}-{ends[q]}"
    return None, None
