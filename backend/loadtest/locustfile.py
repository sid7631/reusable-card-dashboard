"""Load test: viewers opening the Enterprise Spend Overview dashboard.

Each simulated user signs in through the (simulated) SSO service, then repeatedly loads the dashboard
— detail + one streamed /render for all 12 cards — with filters drawn from a realistic mix.

    # cached/mixed traffic (most viewers share a handful of filter combinations)
    uv run locust -f loadtest/locustfile.py --host http://localhost:8011 --headless -u 1000 -r 100 -t 60s
    # cold traffic: every request uses a filter combination nobody has asked for
    COLD=1 uv run locust -f loadtest/locustfile.py --host http://localhost:8011 --headless -u 100 -r 20 -t 60s
"""

import os
import random
import uuid

import requests
from locust import FastHttpUser, between, events, task

AUTH_URL = os.environ.get("AUTH_URL", "http://localhost:3001")
DASHBOARD = os.environ.get("DASHBOARD_ID")
COLD = os.environ.get("COLD") == "1"
USERS = ["u-avery", "u-riley", "u-jordan"]
SEGMENTS = {"GCS": ["SBS", "MM", "G&L"], "ICS": ["Consumer", "SBS", "Corporate"], "USCS": ["Consumer", "SBS"]}
PERIODS = [("2026-01-01", "2026-06-11")] * 4 + [("2026-01-01", "2026-03-31"), ("2025-01-01", "2025-12-31")]
TOKENS: dict[str, str] = {}


@events.test_start.add_listener
def _tokens(environment, **_):
    for u in USERS:
        TOKENS[u] = requests.post(f"{AUTH_URL}/auth/token", json={"user_id": u}, timeout=10).json()["access_token"]


class DashboardViewer(FastHttpUser):
    wait_time = between(1, 3)  # think time between dashboard loads

    def on_start(self):
        self.headers = {"Authorization": f"Bearer {TOKENS[random.choice(USERS)]}", "Content-Type": "application/json"}
        dash_id = DASHBOARD or next(d["id"] for d in self.client.get("/api/dashboards", headers=self.headers).json()
                                    if d["name"] == "Enterprise Spend Overview")
        self.dashboard = int(dash_id)
        self.items = [i["item_id"] for i in self.client.get(f"/api/dashboards/{self.dashboard}", headers=self.headers).json()["items"]]

    def _filters(self) -> tuple[dict, tuple[str, str]]:
        if COLD:  # a combination unlikely to be cached: random merchant subset + random month
            dims = {"merchant": random.sample(["Amazon", "Walmart", "Stripe", "Apple", "Uber", "Costco", "Tesco", "FedEx"], 3),
                    "product": [random.choice(["Gold", "Green", "Platinum"])]}
            month = random.randint(1, 12)
            return dims, (f"2025-{month:02d}-01", f"2025-{month:02d}-28")
        roll = random.random()
        if roll < 0.6:
            dims = {}
        else:
            seg = random.choice(list(SEGMENTS))
            dims = {"segment": [seg]}
            if roll > 0.9:
                dims["sub_segment"] = [random.choice(SEGMENTS[seg])]
        return dims, random.choice(PERIODS)

    @task
    def open_dashboard(self):
        self.client.get(f"/api/dashboards/{self.dashboard}", headers=self.headers, name="dashboard detail")
        dims, (date_from, date_to) = self._filters()
        body = {"items": [{"item_id": i, "filters": dims, "date_from": date_from, "date_to": date_to} for i in self.items]}
        with self.client.post(f"/api/dashboards/{self.dashboard}/render", json=body, headers=self.headers,
                              name="render (12 cards, streamed)", catch_response=True) as res:
            text = res.text or ""
            cards = text.count("event: card")
            errors = text.count('"error"')
            if res.status_code != 200 or cards != len(self.items) or errors:
                res.failure(f"status={res.status_code} cards={cards} errors={errors} {uuid.uuid4().hex[:4]}")
