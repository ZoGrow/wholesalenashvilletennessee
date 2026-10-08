#!/usr/bin/env python3
"""Daily lead pipeline: Apify actor -> CSV -> GoHighLevel contacts -> outreach workflow.

Steps
  1. Run an Apify actor (or read its latest successful run) and fetch the dataset.
  2. Map each item to a lead row using config.json "field_map", drop rows with no
     phone and no email, dedupe, and write leads_YYYY-MM-DD.csv.
  3. Upsert each lead into GoHighLevel with a tag (e.g. "apify-daily-lead").
     A GHL workflow with trigger "Contact Tag added = apify-daily-lead" starts the
     outreach. Optionally also enrolls each contact in GHL_WORKFLOW_ID directly.

Nothing is sent to GoHighLevel unless you pass --send. Without it the script is a
dry run: it builds the CSV and prints what it would push.

Secrets come from environment variables only (never put them in config.json):
  APIFY_TOKEN        Apify API token (Settings > Integrations in Apify console)
  GHL_TOKEN          GoHighLevel Private Integration token (Settings > Private Integrations)
  GHL_LOCATION_ID    GoHighLevel sub-account (location) id
  GHL_WORKFLOW_ID    optional; enroll contacts in this workflow directly

Only the Python standard library is used.
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

APIFY_BASE = "https://api.apify.com/v2"
GHL_BASE = "https://services.leadconnectorhq.com"
GHL_VERSION = "2021-07-28"

CSV_COLUMNS = [
    "first_name", "last_name", "full_name", "phone", "email",
    "company", "website", "address", "city", "state", "postal_code", "source_url",
]

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- http helper

def http_json(method, url, headers=None, body=None, timeout=120, retries=4):
    """JSON request with retries on 429/5xx. Returns parsed JSON (or None)."""
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        hdrs["Content-Type"] = "application/json"
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            raise RuntimeError(f"{method} {url.split('?')[0]} -> HTTP {e.code}: {detail}") from None
        except urllib.error.URLError:
            if attempt < retries:
                time.sleep(2 ** (attempt + 1))
                continue
            raise


# ---------------------------------------------------------------------- apify

def apify_headers():
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        sys.exit("APIFY_TOKEN is not set")
    return {"Authorization": f"Bearer {token}"}


def actor_path(actor_id):
    # Apify accepts "username~actor-name" or the raw actor id in URLs.
    return urllib.parse.quote(actor_id.replace("/", "~"), safe="~")


def fetch_apify_items(cfg):
    actor = cfg["apify"]["actor_id"]
    mode = cfg["apify"].get("mode", "run")  # "run" = start a fresh run, "last" = latest successful run
    h = apify_headers()

    if mode == "last":
        dataset_url = f"{APIFY_BASE}/acts/{actor_path(actor)}/runs/last/dataset/items?status=SUCCEEDED&clean=true&format=json"
        print(f"Reading latest successful run of {actor}")
        return http_json("GET", dataset_url, h) or []

    print(f"Starting Apify actor {actor}")
    run = http_json("POST", f"{APIFY_BASE}/acts/{actor_path(actor)}/runs",
                    h, cfg["apify"].get("input", {}))["data"]
    run_id = run["id"]
    deadline = time.time() + cfg["apify"].get("max_wait_minutes", 60) * 60
    while run["status"] in ("READY", "RUNNING"):
        if time.time() > deadline:
            sys.exit(f"Apify run {run_id} still running after max_wait_minutes; giving up")
        time.sleep(15)
        run = http_json("GET", f"{APIFY_BASE}/actor-runs/{run_id}", h)["data"]
        print(f"  run {run_id}: {run['status']}")
    if run["status"] != "SUCCEEDED":
        sys.exit(f"Apify run {run_id} ended with status {run['status']}")

    items, offset, limit = [], 0, 1000
    while True:
        page = http_json("GET",
                         f"{APIFY_BASE}/datasets/{run['defaultDatasetId']}/items"
                         f"?clean=true&format=json&offset={offset}&limit={limit}", h) or []
        items.extend(page)
        if len(page) < limit:
            return items
        offset += limit


# ------------------------------------------------------------------ transform

def get_path(item, path):
    """Read a value by dotted path, e.g. "owner.phones.0.number"."""
    cur = item
    for part in path.split("."):
        if isinstance(cur, list) and part.isdigit():
            idx = int(part)
            cur = cur[idx] if idx < len(cur) else None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def first_value(item, paths):
    for p in paths if isinstance(paths, list) else [paths]:
        v = get_path(item, p)
        if isinstance(v, list):
            v = v[0] if v else None
        if isinstance(v, dict):  # e.g. {"number": "..."}
            v = next((x for x in v.values() if isinstance(x, (str, int))), None)
        if v not in (None, ""):
            return str(v).strip()
    return ""


def normalize_phone(raw, default_country="1"):
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 10:
        return f"+{default_country}{digits}"
    if len(digits) == 11 and digits.startswith(default_country):
        return f"+{digits}"
    return f"+{digits}" if len(digits) > 11 else ""


def to_lead(item, field_map):
    lead = {col: first_value(item, field_map.get(col, [])) for col in CSV_COLUMNS}
    lead["phone"] = normalize_phone(lead["phone"])
    lead["email"] = lead["email"].lower()
    if not lead["full_name"]:
        lead["full_name"] = " ".join(x for x in (lead["first_name"], lead["last_name"]) if x)
    if lead["full_name"] and not (lead["first_name"] or lead["last_name"]):
        parts = lead["full_name"].split()
        lead["first_name"], lead["last_name"] = parts[0], " ".join(parts[1:])
    return lead


def build_leads(items, cfg):
    leads, seen, skipped = [], set(), 0
    for item in items:
        lead = to_lead(item, cfg["field_map"])
        if not (lead["phone"] or lead["email"]):
            skipped += 1
            continue
        key = lead["phone"] or lead["email"]
        if key in seen:
            continue
        seen.add(key)
        leads.append(lead)
    print(f"{len(items)} items -> {len(leads)} leads ({skipped} skipped: no phone or email)")
    return leads


def write_csv(leads, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"leads_{dt.date.today().isoformat()}.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(leads)
    print(f"Wrote {path}")
    return path


# ---------------------------------------------------------------- gohighlevel

def ghl_headers():
    token = os.environ.get("GHL_TOKEN")
    if not token:
        sys.exit("GHL_TOKEN is not set")
    return {"Authorization": f"Bearer {token}", "Version": GHL_VERSION}


def ghl_contact_body(lead, location_id, cfg):
    body = {
        "locationId": location_id,
        "firstName": lead["first_name"] or None,
        "lastName": lead["last_name"] or None,
        "name": lead["full_name"] or None,
        "phone": lead["phone"] or None,
        "email": lead["email"] or None,
        "address1": lead["address"] or None,
        "city": lead["city"] or None,
        "state": lead["state"] or None,
        "postalCode": lead["postal_code"] or None,
        "companyName": lead["company"] or None,
        "website": lead["website"] or None,
        "source": cfg["ghl"].get("source", "Apify daily pipeline"),
    }
    return {k: v for k, v in body.items() if v is not None}


def push_to_ghl(leads, cfg):
    location_id = os.environ.get("GHL_LOCATION_ID")
    if not location_id:
        sys.exit("GHL_LOCATION_ID is not set")
    workflow_id = os.environ.get("GHL_WORKFLOW_ID")
    h = ghl_headers()
    ok = failed = 0
    for lead in leads:
        try:
            res = http_json("POST", f"{GHL_BASE}/contacts/upsert", h,
                            ghl_contact_body(lead, location_id, cfg))
            contact_id = res["contact"]["id"]
            # Tags are added separately so existing tags are kept. GHL only fires a
            # "tag added" trigger when the tag is new, so a lead that shows up again
            # on a later day is updated but does not get the outreach twice.
            http_json("POST", f"{GHL_BASE}/contacts/{contact_id}/tags", h,
                      {"tags": cfg["ghl"]["tags"]})
            if workflow_id and res.get("new", True):
                http_json("POST", f"{GHL_BASE}/contacts/{contact_id}/workflow/{workflow_id}", h, {})
            ok += 1
        except Exception as e:  # keep going; one bad lead shouldn't stop the batch
            failed += 1
            print(f"  failed {lead['phone'] or lead['email']}: {e}")
        time.sleep(0.25)  # stays well under GHL's burst rate limit
    print(f"GoHighLevel: {ok} upserted, {failed} failed")
    return failed


# ----------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--send", action="store_true",
                    help="actually push to GoHighLevel (default is a dry run)")
    ap.add_argument("--input-json", help="use a local JSON file of items instead of calling Apify")
    ap.add_argument("--limit", type=int, help="only process the first N leads (for testing)")
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)

    if args.input_json:
        with open(args.input_json) as f:
            items = json.load(f)
    else:
        items = fetch_apify_items(cfg)

    leads = build_leads(items, cfg)
    if args.limit:
        leads = leads[: args.limit]
    write_csv(leads, os.path.join(HERE, cfg.get("output_dir", "output")))

    if not args.send:
        print("Dry run: nothing sent to GoHighLevel. Sample of what would be pushed:")
        for lead in leads[:3]:
            print("  " + json.dumps(ghl_contact_body(lead, "<GHL_LOCATION_ID>", cfg)))
        return 0
    return 1 if push_to_ghl(leads, cfg) and cfg["ghl"].get("fail_on_errors") else 0


if __name__ == "__main__":
    sys.exit(main())
