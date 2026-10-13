"""A small JSON API for the demo REST data source (seeded as "Merchant Partner Program").

Served outside /api like the probes: the web server only forwards /api, so it is reachable from the
API and workers (which fetch it) but not from the public site. Deterministic, no auth.
"""

from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/demo", include_in_schema=False)

TIERS = ["Platinum", "Gold", "Silver"]
REGIONS = {"US": "Americas", "UK": "EMEA", "Japan": "APAC"}


def partners() -> list[dict[str, Any]]:
    from app.seed.__main__ import MERCHANTS, mulberry32  # demo vocabulary lives with the seed data

    rng = mulberry32(20261012)
    out = []
    for i, m in enumerate(MERCHANTS):
        name, industry, sub_industry = m[0], m[1], m[2]
        weight = m[3]
        country = m[4] if len(m) > 4 else "Global"
        tier = TIERS[0] if weight >= 5 else TIERS[1] if weight >= 3 else TIERS[2]
        enrollments = int(weight * 42_000 * (0.7 + rng() * 0.6))
        out.append({
            "partner_id": f"P{1001 + i}",
            "merchant": name,
            "industry": industry,
            "sub_industry": sub_industry,
            # Nested object: the REST connector flattens it into program_tier, program_since, …
            "program": {
                "tier": tier,
                "region": REGIONS.get(country, "Global"),
                "since": (date(2019, 1, 1) + timedelta(days=int(rng() * 2400))).isoformat(),
                "status": "Paused" if rng() < 0.12 else "Active",
            },
            "active_offers": 1 + int(rng() * weight * 3),
            "enrolled_cardmembers": enrollments,
            "rewards_cost_usd": round(enrollments * (1.8 + rng() * 2.4), 2),
            "satisfaction": round(3.4 + rng() * 1.5, 1),
        })
    return out


@router.get("/merchant-partners")
async def merchant_partners() -> dict[str, Any]:
    return {"data": {"partners": partners()}, "source": "SpendBoard demo partner API"}
