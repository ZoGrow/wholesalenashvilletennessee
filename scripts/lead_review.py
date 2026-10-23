"""Read-only: review agents who texted back in the last N days (default 2): how the bot sorted them
(qualified, didn't qualify, warm, handed off, opted out), why leads didn't qualify (bot notes), and any
texts the bot never answered. Saves stats/lead_review.json."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else 2
now = datetime.now(timezone.utc)
since = now - timedelta(days=DAYS)
BUCKETS = ["qualified-lead", "hot-lead", "not-qualified", "warm-lead", "opted-out", "bot-off"]

def get(path):
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise

def when(v):
    if isinstance(v, (int, float)): return datetime.fromtimestamp(v / 1000, tz=timezone.utc)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))

out = {"days": DAYS, "agents_replied": 0, "buckets": Counter(), "still_vetting": 0, "unanswered": [],
       "not_qualified_reasons": [], "qualified": [], "handed_off_not_qualified": []}
after = None
done = False
while not done:
    q = {"locationId": loc, "limit": 100, "sortBy": "last_message_date", "sort": "desc"}
    if after: q["startAfterDate"] = after
    convs = get("/conversations/search?" + urllib.parse.urlencode(q)).get("conversations", [])
    if not convs: break
    for c in convs:
        if when(c.get("lastMessageDate") or 0) < since: done = True; break
        m = get(f"/conversations/{c['id']}/messages?limit=60").get("messages", {})
        ms = sorted([x for x in (m.get("messages", []) if isinstance(m, dict) else m)
                     if x.get("messageType") == "TYPE_SMS" or x.get("type") == 2], key=lambda x: x["dateAdded"])
        inbound = [x for x in ms if x.get("direction") == "inbound" and when(x["dateAdded"]) >= since]
        if not inbound: continue
        contact = get(f"/contacts/{c['contactId']}").get("contact", {})
        tags = {t.lower() for t in contact.get("tags") or []}
        if "apify-daily-lead" not in tags: continue
        out["agents_replied"] += 1
        name = f"{contact.get('firstName') or ''} {contact.get('lastName') or ''}".strip()
        hit = [b for b in BUCKETS if b in tags]
        for b in hit: out["buckets"][b] += 1
        if not hit: out["still_vetting"] += 1
        last = ms[-1]
        if last.get("direction") == "inbound" and not ({"hot-lead", "bot-off", "opted-out", "dnd-skipped"} & tags) \
                and now - when(last["dateAdded"]) > timedelta(minutes=10):
            out["unanswered"].append({"name": name, "city": contact.get("city"), "text": (last.get("body") or "[photo]")[:120],
                                      "at": last["dateAdded"]})
        if hit and ("not-qualified" in tags or "hot-lead" in tags or "qualified-lead" in tags):
            notes = get(f"/contacts/{c['contactId']}/notes").get("notes", [])
            note = next((n.get("body") for n in notes if "SMS bot" in (n.get("body") or "")), "")
            row = {"name": name, "city": contact.get("city"), "note": (note or "")[:300]}
            if "qualified-lead" in tags: out["qualified"].append(row)
            elif "not-qualified" in tags: out["not_qualified_reasons"].append(row)
            else: out["handed_off_not_qualified"].append(row)
    if done: break
    after = convs[-1].get("lastMessageDate")
    if not after: break
out["buckets"] = dict(out["buckets"])
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/lead_review.json", "w"), indent=1)
print(json.dumps({k: v for k, v in out.items() if not isinstance(v, list)}, indent=1))
