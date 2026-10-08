# Daily Apify → GoHighLevel lead pipeline

Every day: run your Apify actor, turn its results into `output/leads_YYYY-MM-DD.csv`,
upsert each lead into GoHighLevel with the tag `apify-daily-lead`, and let a GHL
workflow triggered by that tag send the outreach.

## How it fits together

1. **Apify** – `pipeline.py` starts the actor named in `config.json` and waits for it
   (or, with `"mode": "last"`, reads the actor's latest successful run if you already
   schedule it inside Apify).
2. **CSV** – items are mapped to name, phone, email and property address using
   `field_map` (a list of possible keys per column, dotted paths allowed). Rows with no
   phone and no email are dropped; duplicates are removed; phones become +1XXXXXXXXXX.
3. **GoHighLevel** – each lead goes to `POST /contacts/upsert` (no duplicate contacts),
   then the tag is added. An agent who already has the tag from an earlier day is
   updated but not re-triggered, so nobody gets the outreach twice. If `GHL_WORKFLOW_ID` is set it is also enrolled in that workflow directly.
4. **Outreach** – built in GHL: Automation → Workflows → trigger "Contact Tag",
   tag is `apify-daily-lead` → your SMS / email / call steps.
5. **Daily schedule** – `.github/workflows/daily-leads.yml` runs it at 13:00 UTC on
   GitHub Actions (free) and keeps each day's CSV for 30 days.

## Cleaning (before anything reaches GHL)

Each run removes: agents with no number marked Mobile, invalid / toll-free / fake 555
numbers, agents with no name, numbers listed for several different agents (team or
office lines), duplicates, and anything in `suppression.csv`. Removed rows and the
reason go to `output/removed_YYYY-MM-DD.csv`.

In GHL, contacts are first created untagged; after a short wait the script reads each
one back and only tags the ones GHL has not put on Do Not Disturb. DND contacts get the
tag `dnd-skipped` instead and never enter the outreach workflow.

## Setup

1. `config.json` is set up for `automation-lab/realtor-agents-scraper`. Set
   `apify.input.locations` to your markets (cities, states or ZIPs), `listingStatus`
   (`both`, `for_sale`, `sold`, `for_rent`) and `maxResults` (agents per run, max 5000).
   Cost is about $5 per 1,000 agents on Apify's Bronze plan.
2. Get the keys (never paste them into chat or config files):
   - `APIFY_TOKEN` – Apify console → Settings → API & Integrations.
   - `GHL_TOKEN` – GHL sub-account → Settings → Private Integrations, with
     contacts.write (and workflows.readonly if using GHL_WORKFLOW_ID).
   - `GHL_LOCATION_ID` – GHL sub-account → Settings → Business Profile.
3. Test locally without sending anything:
   `export APIFY_TOKEN=...` then `python3 pipeline.py` (dry run, writes the CSV only).
   Then `python3 pipeline.py --send --limit 2` to push two leads.
4. Put this folder in a private GitHub repo, add the four values under
   Settings → Secrets and variables → Actions, and the schedule takes over.

## Before going live

Cold SMS and calls to skip-traced owners fall under TCPA / DNC rules, and GHL needs
A2P 10DLC registration for SMS. Scrub against DNC and keep an opt-out step in the workflow.
