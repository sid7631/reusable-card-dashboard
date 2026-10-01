# Load test baseline

Phase 5 baseline for the Enterprise Spend Overview dashboard (12 cards). Re-run after changes to
execution, caching or the data model and compare.

```bash
# API under test: several processes, no auto-reload
cd backend && uv run uvicorn app.main:app --port 8011 --workers 4
# warm/mixed traffic
uv run locust -f loadtest/locustfile.py --host http://localhost:8011 --headless -u 1000 -r 100 -t 60s --processes 4
# cold traffic (nearly every request is a new filter combination)
COLD=1 DASHBOARD_ID=14 uv run locust -f loadtest/locustfile.py --host http://localhost:8011 --headless -u 100 -r 20 -t 60s --processes 2
```

**Environment:** one MacBook Air (8 cores) running everything — Locust, 4 API processes, 8 Celery
worker processes, Postgres 16, Redis 7. Production numbers will differ; the ratios are what matter.

## Results (2026-10-01)

| Scenario | Users | Dashboard renders/s | Card results/s | Render p50 | Render p95 | Failures | Cache hit ratio | Card compute p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| Mixed (60% default filters, 40% segment / sub-segment, 6 periods) | 1000 | 229 | ~2,700 | 750 ms | 2.3 s | 0 | 99.1% | 39 ms / 195 ms |
| Cold (unique filters per request) | 100 | 23 | ~280 | 2.2 s | 2.7 s | 0 | 7% | 15 ms / 36 ms |

A render is the full streamed response for all 12 cards; cached cards stream first, so the first
cards paint well before the render completes. A cached render on an idle system takes ~15 ms.

## Reading the numbers

- **Mixed:** 167k card lookups needed only 1,007 queries (single-flight merged 1,539 misses). Latency is
  CPU contention on the shared laptop — the uncached `dashboard detail` endpoint shows the same
  p50 — not card execution. Scale out API processes / hosts for this profile.
- **Cold:** queries themselves are fast (15 ms p50); render time is queueing for the 8 prefork worker
  processes, each running one job at a time. More worker processes, or an asyncio-native worker that
  runs many I/O-bound queries per process, raise this ceiling. Per-source concurrency limits keep the
  source protected either way (demo warehouse: 10 concurrent queries cluster-wide).
- **Huge / slow sources:** queueing grows with source latency. Extracts and pre-aggregations
  (architecture §8.3) move those queries off the source.
