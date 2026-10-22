"""Read-only: count today's (Central time) SMS in GHL: texts sent, delivered, failed (by reason),
contacts reached and replies. Pass a date (YYYY-MM-DD) to count another day. Saves stats/texts_today.json."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
CT = ZoneInfo("America/Chicago")
day = datetime.strptime(sys.argv[1], "%Y-%m-%d").date() if len(sys.argv) > 1 and sys.argv[1] else datetime.now(CT).date()
start = datetime(day.year, day.month, day.day, tzinfo=CT)
end = start + timedelta(days=1)

def get(path):
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise

def when(v):
    if isinstance(v, (int, float)): return datetime.fromtimestamp(v / 1000, tz=CT)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(CT)

out = {"date": str(day), "conversations_checked": 0, "texts_sent": 0, "status": Counter(), "errors": Counter(),
       "contacts_texted": 0, "contacts_reached": 0, "replies": 0, "contacts_replied": 0}
texted, reached, replied = set(), set(), set()
after = None
while True:
    q = {"locationId": loc, "limit": 100, "sortBy": "last_message_date", "sort": "desc"}
    if after: q["startAfterDate"] = after
    convs = get("/conversations/search?" + urllib.parse.urlencode(q)).get("conversations", [])
    if not convs: break
    for c in convs:
        if when(c.get("lastMessageDate") or 0) < start: convs = []; break
        out["conversations_checked"] += 1
        m = get(f"/conversations/{c['id']}/messages?limit=100").get("messages", {})
        for x in (m.get("messages", []) if isinstance(m, dict) else m):
            if not (x.get("messageType") == "TYPE_SMS" or x.get("type") == 2): continue
            t = when(x["dateAdded"])
            if not (start <= t < end): continue
            if x.get("direction") == "outbound":
                out["texts_sent"] += 1; texted.add(c["contactId"])
                st = x.get("status") or "unknown"; out["status"][st] += 1
                if st in ("delivered", "sent", "read"): reached.add(c["contactId"])
                if st in ("failed", "undelivered"): out["errors"][(x.get("error") or "none")[:80]] += 1
            else:
                out["replies"] += 1; replied.add(c["contactId"])
    if not convs: break
    after = convs[-1].get("lastMessageDate") or convs[-1].get("sort", [None])[0]
    if not after: break
out.update(contacts_texted=len(texted), contacts_reached=len(reached), contacts_replied=len(replied),
           status=dict(out["status"]), errors=dict(out["errors"].most_common(8)))
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/texts_today.json", "w"), indent=1)
print(json.dumps(out, indent=1))
