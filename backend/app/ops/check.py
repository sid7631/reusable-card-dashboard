"""Worker liveness probe: exit 1 when workers are stuck, so the platform restarts them.

    python -m app.ops.check            # exit 0 healthy / 1 stuck — use as the worker's liveness probe
    python -m app.ops.check --verbose  # also print the snapshot

The signal is cluster-wide: if card jobs wait and *no* worker has made progress for STUCK_AFTER_S,
any healthy worker would have taken them, so every worker is stuck and restarting all of them is right.
Only stuck workers fail this check — an unreachable Postgres or Redis is the API's readiness problem,
and restarting workers wouldn't fix it.
"""

import asyncio
import json
import sys

from app.ops.health import snapshot


async def main(verbose: bool) -> int:
    snap = await snapshot()
    if verbose:
        print(json.dumps(snap.public(), indent=2))
    elif snap.workers_stuck:
        print("; ".join(snap.reasons))
    return 1 if snap.workers_stuck else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--verbose" in sys.argv)))
