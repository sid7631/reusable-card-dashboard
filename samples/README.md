# Sample files for testing uploads

Upload these under **Data Sources → + New data source → File** to try the whole flow: upload, the suggested
semantic model, building cards on it, publishing, and dashboards. They're made up but match the demo data
(same segments, merchants and card products), so cards on them sit naturally next to the demo cards.

| File | Rows | What it has | Good for |
| --- | --- | --- | --- |
| `marketing_campaigns.csv` | 72 | One row per campaign: channel, segment / sub-segment, start and end dates, budget, spend, impressions, clicks, new accounts, an active true/false flag | Segment filters (it has `segment` and `sub_segment` like the demo), KPIs, bar charts by channel, a time series by start date |
| `merchant_targets.csv` | 288 | Monthly target vs actual per merchant (12 merchants × 24 months, 2025–2026), industry, account manager | Line charts of target vs actual over time, top merchants, period filters |
| `customer_satisfaction.csv` | 360 | Monthly survey results by card product, country and channel: responses, NPS score, CSAT %, complaints | Averages (NPS, CSAT), grouping by product or country, a non-money KPI |

Things to check with them:

- The suggested model: the first date column becomes the time axis (other dates stay dimensions); amounts become
  summed measures, shown as currency when the name says so (`Total spend usd`); scores and percentages are averaged
  (`Average nps score`, `Average csat pct` shown as a percent); text becomes dimensions; `is_active` becomes a
  true/false dimension. You can change any of it before saving.
- Cards built on an uploaded file run on DuckDB, so SQL cards use DuckDB SQL (e.g. `strftime(month, '%Y-%m')`).
- Uploading the same file again creates a separate copy; you can upload them as often as you like.
- Each upload starts as a **private** data source. Use **Request publish** to put it in the global library.

For a step-by-step walkthrough of every flow (as each demo account), see [TEST-CHECKLIST.md](TEST-CHECKLIST.md).
