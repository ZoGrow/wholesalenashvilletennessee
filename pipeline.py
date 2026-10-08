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
# GHL sits behind Cloudflare, which blocks Python's default "Python-urllib" user agent
# (error 1010), so every request identifies itself with a regular browser-style one.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

CSV_COLUMNS = [
    "first_name", "last_name", "full_name", "phone", "email",
    "company", "website", "address", "city", "state", "postal_code", "source_url",
]

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- http helper

def http_json(method, url, headers=None, body=None, timeout=120, retries=4):
    """JSON request with retries on 429/5xx. Returns parsed JSON (or None)."""
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
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


def get_secret(name, required=True):
    """Read a secret from the environment, catching common copy-paste mistakes."""
    value = (os.environ.get(name) or "").strip()
    if not value:
        if required:
            sys.exit(f"{name} is not set")
        return None
    if not value.isascii() or any(c.isspace() for c in value):
        sys.exit(f"{name} contains spaces or non-standard characters (e.g. an arrow or "
                 f"curly quote). Re-paste only the key itself into the GitHub secret.")
    return value


# ---------------------------------------------------------------------- apify

def apify_headers():
    token = get_secret("APIFY_TOKEN")
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


def mobile_phone(item, mobile_cfg):
    """Pick the first phone whose type looks like a cell number, e.g.
    {"phones": [{"number": "5125549618", "type": "Mobile"}]}. Returns "" if none."""
    phones = get_path(item, mobile_cfg.get("list_path", "phones")) or []
    wanted = [t.lower() for t in mobile_cfg.get("types", ["mobile", "cell"])]
    for ph in phones if isinstance(phones, list) else []:
        if isinstance(ph, dict) and str(ph.get("type", "")).lower() in wanted:
            return str(ph.get("number", ""))
    return ""


def to_lead(item, field_map, mobile_cfg=None):
    lead = {col: first_value(item, field_map.get(col, [])) for col in CSV_COLUMNS}
    if mobile_cfg:
        # Texts can't reach landlines, so only use a phone the source marks as mobile.
        lead["phone"] = mobile_phone(item, mobile_cfg)
    lead["phone"] = normalize_phone(lead["phone"])
    lead["email"] = lead["email"].lower()
    if not lead["full_name"]:
        lead["full_name"] = " ".join(x for x in (lead["first_name"], lead["last_name"]) if x)
    if lead["full_name"] and not (lead["first_name"] or lead["last_name"]):
        parts = lead["full_name"].split()
        lead["first_name"], lead["last_name"] = parts[0], " ".join(parts[1:])
    return lead


TOLL_FREE = {"800", "833", "844", "855", "866", "877", "888"}


def phone_problem(phone):
    """Return why a +1 number can't be a real US mobile, or "" if it looks fine."""
    digits = phone[2:] if phone.startswith("+1") else ""
    if len(digits) != 10:
        return "not a US number"
    area, exchange, line = digits[:3], digits[3:6], digits[6:]
    if area[0] in "01" or exchange[0] in "01" or area[1:] == "11":
        return "invalid number"
    if area in TOLL_FREE:
        return "toll-free number"
    if exchange == "555" and line.startswith("01"):
        return "fake 555 number"
    return ""


def load_suppression(cfg):
    """Numbers and emails to never contact (opt-outs, people you know), one per line."""
    path = cfg.get("suppression_file")
    if not path or not os.path.exists(os.path.join(HERE, path)):
        return set()
    out = set()
    with open(os.path.join(HERE, path)) as f:
        for line in f:
            value = line.split(",")[0].strip()
            if not value or value.startswith("#"):
                continue
            out.add(value.lower() if "@" in value else normalize_phone(value))
    return out


def build_leads(items, cfg):
    """Clean the scraped items. Returns (leads, rejected); rejected rows carry a reason."""
    mobile_cfg = cfg.get("mobile_only")
    suppressed = load_suppression(cfg)
    rows = [to_lead(item, cfg["field_map"], mobile_cfg) for item in items]

    # The same "mobile" listed for several agents is a team or office line, not a person.
    names_by_phone = {}
    for r in rows:
        if r["phone"]:
            names_by_phone.setdefault(r["phone"], set()).add(r["full_name"].lower())

    leads, rejected, seen = [], [], set()
    for r in rows:
        reason = ""
        if mobile_cfg and not r["phone"]:
            reason = "no mobile number"
        elif not (r["phone"] or r["email"]):
            reason = "no phone or email"
        elif r["phone"] and phone_problem(r["phone"]):
            reason = phone_problem(r["phone"])
        elif not r["full_name"]:
            reason = "no name"
        elif r["phone"] and len(names_by_phone[r["phone"]]) > 1:
            reason = "number shared by several agents"
        elif r["phone"] in suppressed or (r["email"] and r["email"] in suppressed):
            reason = "on suppression list"
        elif (r["phone"] or r["email"]) in seen:
            reason = "duplicate"
        if reason:
            rejected.append({**r, "reason": reason})
            continue
        seen.add(r["phone"] or r["email"])
        leads.append(r)

    print(f"{len(items)} scraped -> {len(leads)} clean leads, {len(rejected)} removed")
    tally = {}
    for r in rejected:
        tally[r["reason"]] = tally.get(r["reason"], 0) + 1
    for reason, n in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d} {reason}")
    return leads, rejected


def write_csv(leads, out_dir, name="leads", columns=CSV_COLUMNS):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{name}_{dt.date.today().isoformat()}.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        w.writerows(leads)
    print(f"Wrote {path}")
    return path


# ---------------------------------------------------------------- gohighlevel

def ghl_headers():
    token = get_secret("GHL_TOKEN")
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


def is_dnd(contact):
    """True if GHL has the contact on Do Not Disturb for everything or for SMS."""
    if contact.get("dnd"):
        return True
    sms = (contact.get("dndSettings") or {}).get("SMS") or {}
    return str(sms.get("status", "")).lower() in ("active", "permanent")


def find_existing(lead, location_id, h):
    """Return the GHL contact that already has this phone/email, or None."""
    q = {"locationId": location_id}
    if lead["phone"]:
        q["number"] = lead["phone"]
    else:
        q["email"] = lead["email"]
    res = http_json("GET", f"{GHL_BASE}/contacts/search/duplicate?" + urllib.parse.urlencode(q), h)
    return (res or {}).get("contact")


def push_to_ghl(leads, cfg, target):
    """Send up to `target` clean, textable, brand-new leads to the outreach workflow.

    Works in rounds: create the next batch of contacts untagged, give GHL a moment to
    run its own Do Not Disturb checks, then tag only the ones GHL will let you text.
    DND contacts get `dnd_tag` so they never enter the workflow. Anyone already in GHL
    is left untouched. Repeats until `target` is reached or the leads run out.
    Returns (sent, removed, failed); removed rows carry a reason."""
    location_id = get_secret("GHL_LOCATION_ID")
    workflow_id = get_secret("GHL_WORKFLOW_ID", required=False)
    h = ghl_headers()
    dnd_tag = cfg["ghl"].get("dnd_tag", "dnd-skipped")
    wait = cfg["ghl"].get("dnd_check_delay_seconds", 60)
    sent, removed, failed = [], [], 0
    queue = list(leads)

    while queue and len(sent) < target:
        need = target - len(sent)
        batch = []
        while queue and len(batch) < need:
            lead = queue.pop(0)
            try:
                if find_existing(lead, location_id, h):
                    removed.append({**lead, "reason": "already in GHL"})
                    continue
                res = http_json("POST", f"{GHL_BASE}/contacts/upsert", h,
                                ghl_contact_body(lead, location_id, cfg))
                batch.append((lead, res["contact"]["id"]))
            except Exception as e:  # keep going; one bad lead shouldn't stop the batch
                failed += 1
                print(f"  failed {lead['phone'] or lead['email']}: {e}")
            time.sleep(0.25)  # stays well under GHL's burst rate limit
        if not batch:
            continue

        if wait:
            print(f"Created {len(batch)} contacts; waiting {wait}s for GHL's DND checks")
            time.sleep(wait)

        for lead, contact_id in batch:
            try:
                contact = http_json("GET", f"{GHL_BASE}/contacts/{contact_id}", h)["contact"]
                if is_dnd(contact):
                    http_json("POST", f"{GHL_BASE}/contacts/{contact_id}/tags", h, {"tags": [dnd_tag]})
                    removed.append({**lead, "reason": "DND in GHL"})
                    continue
                # Adding the tag is what starts the GHL outreach workflow.
                http_json("POST", f"{GHL_BASE}/contacts/{contact_id}/tags", h,
                          {"tags": cfg["ghl"]["tags"]})
                if workflow_id:
                    http_json("POST", f"{GHL_BASE}/contacts/{contact_id}/workflow/{workflow_id}", h, {})
                sent.append(lead)
            except Exception as e:
                failed += 1
                print(f"  failed {lead['phone'] or lead['email']}: {e}")
            time.sleep(0.25)

    print(f"GoHighLevel: {len(sent)} of {target} sent to outreach, "
          f"{sum(r['reason'] == 'DND in GHL' for r in removed)} DND (tagged {dnd_tag}), "
          f"{sum(r['reason'] == 'already in GHL' for r in removed)} already in GHL, {failed} failed")
    return sent, removed, failed


# ----------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--send", action="store_true",
                    help="actually push to GoHighLevel (default is a dry run)")
    ap.add_argument("--input-json", help="use a local JSON file of items instead of calling Apify")
    ap.add_argument("--limit", type=int,
                    help="send this many clean leads instead of the daily amount (for testing)")
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)
    # Scrape `target` agents (times scrape_multiplier, if you want extra to make up for
    # the ones cleaning removes). Only leads that pass every check are sent.
    target = args.limit or cfg.get("daily_clean_leads", 100)
    scrape = min(target * cfg.get("scrape_multiplier", 1), 5000)
    cfg["apify"].setdefault("input", {})["maxResults"] = scrape
    print(f"Target: {target} clean leads (scraping up to {scrape} agents)")

    if args.input_json:
        with open(args.input_json) as f:
            items = json.load(f)
    else:
        items = fetch_apify_items(cfg)

    leads, rejected = build_leads(items, cfg)
    out_dir = os.path.join(HERE, cfg.get("output_dir", "output"))

    if not args.send:
        write_csv(leads[:target], out_dir)
        write_csv(rejected, out_dir, "removed", CSV_COLUMNS + ["reason"])
        print("Dry run: nothing sent to GoHighLevel. Sample of what would be pushed:")
        for lead in leads[:3]:
            print("  " + json.dumps(ghl_contact_body(lead, "<GHL_LOCATION_ID>", cfg)))
        return 0

    sent, removed, failed = push_to_ghl(leads, cfg, target)
    write_csv(sent, out_dir)
    write_csv(rejected + removed, out_dir, "removed", CSV_COLUMNS + ["reason"])
    return 1 if failed and cfg["ghl"].get("fail_on_errors", True) else 0


if __name__ == "__main__":
    sys.exit(main())
