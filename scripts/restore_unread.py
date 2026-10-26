"""Marks conversations unread again when the agent texted last and they show as read. The SMS bot's
backup sweep used to mark conversations read (2026-10-23 to 10-26); Zack uses unread to see who he
hasn't answered. Writes a count to stats/restore_unread.json."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else 5
since = datetime.now(timezone.utc) - timedelta(days=DAYS)

def call(path, method="GET", body=None):
    for attempt in range(4):
        try:
            req = urllib.request.Request(GHL + path, headers=H, method=method,
                                         data=json.dumps(body).encode() if body else None)
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise

def when(v):
    if isinstance(v, (int, float)) or str(v).isdigit(): return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))

fixed, failed, after, done = [], 0, None, False
while not done:
    q = {"locationId": loc, "limit": 100, "sortBy": "last_message_date", "sort": "desc"}
    if after: q["startAfterDate"] = after
    convs = call("/conversations/search?" + urllib.parse.urlencode(q)).get("conversations", [])
    if not convs: break
    for c in convs:
        if when(c.get("lastMessageDate") or 0) < since: done = True; break
        if c.get("lastMessageDirection") != "inbound" or c.get("unreadCount", 0) > 0: continue
        try:
            call(f"/conversations/{c['id']}", "PUT", {"locationId": loc, "unreadCount": 1})
            fixed.append(c.get("fullName") or c.get("contactName") or c["contactId"])
        except Exception as e:
            failed += 1; print("failed", c["id"], e)
    after = convs[-1].get("lastMessageDate")
    if len(convs) < 100: break

os.makedirs("stats", exist_ok=True)
json.dump({"marked_unread": len(fixed), "failed": failed, "names": fixed}, open("stats/restore_unread.json", "w"), indent=1)
print(len(fixed), "marked unread,", failed, "failed")
