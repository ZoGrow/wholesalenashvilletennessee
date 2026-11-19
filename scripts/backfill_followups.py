"""Zack 2026-11-19: follow-ups on "maybe / soon" agents bring the best leads. Find warm agents who have no
check-in scheduled anymore (the old 3-check-in cap ran out, or the bot never set one) and schedule one,
spread over the next few days. The bot's normal check-in still decides each text and skips anyone who said no.
MODE=list only counts; MODE=apply adds the follow-up-YYYY-MM-DD tags. Saves stats/backfill_followups.json."""
import json, os, time, urllib.error, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
MODE, PER_DAY = os.environ.get("MODE", "list"), int(os.environ.get("PER_DAY", "40"))
SKIP = {"hot-lead", "qualified-lead", "not-qualified", "opted-out", "bot-off", "dnd-skipped", "checked-in-4"}

def call(method, path, body=None):
    req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3: time.sleep(2 ** attempt); continue
            raise

def tagged(tag):
    out, page = [], 1
    while True:
        r = call("POST", "/contacts/search", {"locationId": loc, "page": page, "pageLimit": 100,
                 "filters": [{"field": "tags", "operator": "contains", "value": tag}]})
        cs = r.get("contacts", [])
        out += cs
        if len(cs) < 100: return out
        page += 1

def last_direction(cid):
    convs = call("GET", f"/conversations/search?locationId={loc}&contactId={cid}").get("conversations", [])
    if not convs: return None
    m = call("GET", f"/conversations/{convs[0]['id']}/messages?limit=10").get("messages", {})
    m = m.get("messages", []) if isinstance(m, dict) else m
    sms = sorted([x for x in m if x.get("messageType") == "TYPE_SMS"], key=lambda x: x["dateAdded"])
    return sms[-1]["direction"] if sms else None

seen, picks, skipped = set(), [], {}
for c in tagged("warm-lead") + tagged("checked-in-2"):
    if c["id"] in seen: continue
    seen.add(c["id"])
    tags = {t.lower() for t in c.get("tags") or []}
    why = ("not outreach" if "apify-daily-lead" not in tags else
           "skip tag" if tags & SKIP else
           "already scheduled" if any(t.startswith("follow-up-") for t in tags) else
           "dnd" if c.get("dnd") else None)
    if not why:
        try:
            d = last_direction(c["id"])
        except urllib.error.HTTPError:
            d = "error"
        why = None if d == "outbound" else "they texted last (bot answers)" if d == "inbound" else f"no thread ({d})"
    if why: skipped[why] = skipped.get(why, 0) + 1; continue
    picks.append(c)

today = datetime.now(ZoneInfo("America/Chicago")).date()
plan = {}
for i, c in enumerate(picks):
    day = (today + timedelta(days=1 + i // PER_DAY)).isoformat()
    plan.setdefault(day, 0); plan[day] += 1
    if MODE == "apply":
        call("POST", f"/contacts/{c['id']}/tags", {"tags": [f"follow-up-{day}"]})
out = {"mode": MODE, "candidates": len(picks), "skipped": skipped, "scheduled_per_day": plan,
       "sample": [f"{c.get('firstName')} {c.get('lastName') or ''} ({c.get('city')})".strip() for c in picks[:15]]}
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/backfill_followups.json", "w"), indent=1)
print(json.dumps(out, indent=1))
