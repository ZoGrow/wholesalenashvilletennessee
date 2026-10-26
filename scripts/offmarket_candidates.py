"""Read-only: agents who texted back in the last N days about a specific house (an address, or words like
off-market, inherited, vacant, needs work) and aren't already a qualified lead or opted out. Saves each
conversation to stats/offmarket_candidates.json so missed leads can be reviewed and sent to Zack."""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else 7
now = datetime.now(timezone.utc)
since = now - timedelta(days=DAYS)
ADDRESS = re.compile(r"\b\d{2,6}\s+[A-Za-z0-9 .']{2,30}\b(st|street|dr|drive|rd|road|ave|avenue|ln|lane|ct|court|way|blvd|cir|circle|pl|place|pkwy|trl|trail|hwy|ter|terrace|loop|run|cove|cv)\b", re.I)
SIGNS = re.compile(r"off[- ]?market|pocket|not listed|inherit|estate|probate|vacant|needs (a lot of )?work|fixer|as[- ]is|tlc|foreclos|behind on|divorce|tired landlord|zillow\.com|realtor\.com|redfin\.com", re.I)
SKIP = {"qualified-lead", "opted-out", "bot-off"}

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

out, after, done = [], None, False
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
        inbound = " ".join(x.get("body") or "" for x in ms if x.get("direction") == "inbound")
        photos = sum(len(x.get("attachments") or []) for x in ms if x.get("direction") == "inbound")
        if not (ADDRESS.search(inbound) or SIGNS.search(inbound) or photos): continue
        contact = get(f"/contacts/{c['contactId']}").get("contact", {})
        tags = {t.lower() for t in contact.get("tags") or []}
        if "apify-daily-lead" not in tags or tags & SKIP: continue
        notes = get(f"/contacts/{c['contactId']}/notes").get("notes", [])
        out.append({"contact_id": c["contactId"],
                    "name": f"{contact.get('firstName') or ''} {contact.get('lastName') or ''}".strip(),
                    "city": contact.get("city"), "state": contact.get("state"), "phone": contact.get("phone"),
                    "company": contact.get("companyName"), "tags": sorted(tags), "photos": photos,
                    "notes": [(n.get("body") or "")[:700] for n in notes[:2]],
                    "thread": [f"{x['direction'][:2]} {x['dateAdded'][5:16]}: {(x.get('body') or '[photo]')[:350]}"
                               for x in ms[-16:]]})
    if done: break
    after = convs[-1].get("lastMessageDate")
    if not after: break
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/offmarket_candidates.json", "w"), indent=1)
print(len(out), "candidates")
