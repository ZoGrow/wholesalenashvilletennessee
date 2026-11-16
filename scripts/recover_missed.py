"""After a bot outage (2026-11-16, dead Claude key): the sweep tagged every failed reply bot-seen-<time> and
never retried. This clears bot-seen tags from contacts whose last text is an unanswered inbound text from the
last HOURS hours, so the bot's sweep answers them again. Saves stats/recover_missed.json."""
import json, os, time, urllib.error, urllib.request
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
HOURS = float(os.environ.get("HOURS") or 96)

def call(method, path, body=None):
    req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
    for attempt in range(5):
        try:
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 4: time.sleep(2 ** attempt); continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < 4: time.sleep(2 ** attempt); continue
            raise

cutoff = (time.time() - HOURS * 3600) * 1000
base = f"/conversations/search?locationId={loc}&sortBy=last_message_date&sort=desc&limit=100"
convs, after = [], ""
for _ in range(40):
    batch = call("GET", base + (f"&startAfterDate={after}" if after else "")).get("conversations", [])
    convs += batch
    if len(batch) < 100 or float(batch[-1]["lastMessageDate"]) < cutoff: break
    after = str(batch[-1]["lastMessageDate"])
out = {"scanned": len(convs), "inbound_waiting": 0, "cleared": 0, "names": []}
for c in convs:
    if float(c["lastMessageDate"]) < cutoff or c.get("lastMessageDirection") != "inbound": continue
    if "SMS" not in (c.get("lastMessageType") or "").upper(): continue
    tags = c.get("tags") or call("GET", f"/contacts/{c['contactId']}").get("contact", {}).get("tags", [])
    if "apify-daily-lead" not in [t.lower() for t in tags]: continue
    out["inbound_waiting"] += 1
    seen = [t for t in tags if t.startswith("bot-seen-")]
    if seen:
        call("DELETE", f"/contacts/{c['contactId']}/tags", {"tags": seen})
        out["cleared"] += 1
        out["names"].append(c.get("fullName") or c.get("contactName") or c["contactId"])
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/recover_missed.json", "w"), indent=1)
print(json.dumps({k: v for k, v in out.items() if k != "names"}))
