# Manual test checklist

A walkthrough of every main flow, in an order where each step sets up the next. Start from fresh demo data
(`npm run seed:reset`, then restart `npm run dev`). Sign in from the account picker; sign out with the icon next
to your name. Request numbers below are the ones a fresh demo creates.

## Riley (analyst)

1. **Dashboards** — open all six. Every card shows data (red numbers are negative year-on-year changes, not
   errors). *Enterprise Spend Overview* shows **Update** chips; Jordan's *Budget Review* is **Read-only**.
2. **Upload a file** — Data Sources → New → File → `marketing_campaigns.csv`. Check: 72 rows, `start_date` is the
   time axis, `spend_usd` is a currency measure, `is_active` is a true/false dimension. **Create private source**
   → shows *PRIVATE v0.1*.
3. **New card** — Card Library → New card → pick the uploaded source → *Start blank*. Set category = Channel,
   value = Total spend usd → preview updates → Save → *v0.1* in the library. Also try *Start from an example* on
   another source.
4. **Edit and history** — edit the card, set Limit 3, save → *v0.2*. History lists both versions.
5. **Change data source** — edit → *change* next to Source → Demo Warehouse → it lists what doesn't carry over →
   *Switch anyway* → save → *v0.3*. History of v0.3 says *Data source: marketing campaigns → Demo Warehouse*.
   *Restore v0.1* creates *v0.4*.
6. **Build a dashboard** — Dashboards → New → Edit → *+ Add widget* → add 3 cards from different sources. They
   show data **before** you save. Save layout → *v0.2*. Filters → + Add filter → Segment → Save.
7. **Share** — Share → *Can edit* → Jordan.
8. **Card updates** — open *Riley — Consumer Watch*: click the **Update** chip on Product Spend → see what changed
   → *Update this card*. Then *Update all*.
9. **Propose a change** — open global *Total AXP Spend* → *Edit a copy* → it opens as *v1.1* → change the colour
   → save → *v1.2* → *Propose changes*. The request lists only the colour change.
10. **Publish the upload** — open the uploaded source → *Request publish*.
11. **Card menu and assistant** — on a dashboard card: ⋮ → View SQL. Open the assistant (bottom right), ask
    “Which segment has the most spend?”, click *Filter to GCS*.

## Avery (admin)

12. **Approvals** — the sidebar shows requests in review and unread messages. On Riley's copy request: write a
    comment → *Comment*; write a note → **Request changes**. Status becomes *Changes requested*.
13. **Approve** — approve the upload (*published as v1*). On #2 (top 10 merchants) note *“Approving this also
    affects request #3”*, approve; then approve #3 — it merges without a conflict (both changes are in the result).
14. **Delete in use** — Card Library → Delete on *ICS Spend*: the warning lists the dashboards using it → delete.
    It's in the **Deleted** tab; on dashboards it still shows data with a **Deleted** chip; *Update all* on the
    overview still saves.
15. **Delete warning for a source** — Data Sources → delete on *Budget Plan (CSV)* lists the cards using it →
    Cancel.

## Riley again

16. **Deleted card** — on *Consumer Watch*, ICS Spend shows **Deleted** (hover for why); it isn't offered in
    *+ Add widget*; removing it and saving works.
17. **Changes requested** — My requests shows it with new messages. Edit the copy, then on the request write a
    note → **Send back for review** → back *In review* with the new version.

## Jordan (analyst)

18. **Resolve a conflict** — open #5 (*Changes requested*) → **Resolve conflicts** → one decision (SQL query, with
    its limit setting following) → *Keep all mine* → *Update my copy* → the copy becomes *v2.1* and the conflict
    is gone → **Send back for review**.
19. **Edit a shared dashboard** — open Riley's shared dashboard (*SHARED · EDIT*) → add a widget → Save layout →
    new version saved (no Share button for editors).

## Morgan (admin)

20. **Approve with a version** — approve #5. On Riley's resubmitted request change *Publish as v* to 5 →
    *published as v5*.
21. **Restore** — Card Library → Deleted → Restore *ICS Spend* → back in the library. Delete a dashboard (*Nothing
    uses it*) and restore it from its Deleted tab.
22. **Deleted original** — delete the published upload source (*1 person has their own copy*). As Riley, the
    private source now says *the global original was deleted* and offers *Request publish*. Restore it as Morgan.

The other two sample files (`merchant_targets.csv`, `customer_satisfaction.csv`) go through step 2 the same way;
on the satisfaction file, NPS and CSAT are suggested as averages, CSAT as a percent.
