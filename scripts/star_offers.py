"""Star the GHL conversation of every agent in stats/offers_all.json (Zack 2026-10-29: star all offers)."""
import json, os, time, urllib.error, urllib.parse, urllib.request
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]

def call(method, path, body=None):
    for attempt in range(5):
        try:
            req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(2 ** attempt); continue
            raise

starred = 0
for r in json.load(open("stats/offers_all.json")):
    q = urllib.parse.urlencode({"locationId": loc, "contactId": r["contact_id"]})
    for c in call("GET", f"/conversations/search?{q}").get("conversations", []):
        call("PUT", f"/conversations/{c['id']}", {"locationId": loc, "starred": True}); starred += 1
print("starred", starred)
