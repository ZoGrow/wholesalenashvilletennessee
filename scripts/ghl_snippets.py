"""Read-only: dump the GHL location's message templates (snippets) to stats/ghl_snippets.json."""
import json, os, urllib.error, urllib.parse, urllib.request
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
out = {}
for q in ({"originId": loc}, {"originId": loc, "type": "sms"}, {"originId": loc, "type": "email"}):
    try:
        url = f"{GHL}/locations/{loc}/templates?" + urllib.parse.urlencode({**q, "limit": 100})
        out[json.dumps(q)] = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60))
    except urllib.error.HTTPError as e:
        out[json.dumps(q)] = {"error": e.code, "body": e.read().decode()[:500]}
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/ghl_snippets.json", "w"), indent=1)
print({k: len(v.get("templates", [])) if isinstance(v, dict) else v for k, v in out.items()})
