"""Fix all-caps cities on contacts tagged apify-daily-lead (e.g. NASHVILLE -> Nashville).
Run with APPLY=true to change them; otherwise it only counts. Summary saved to stats/city_fix.json."""
import json, os, re, sys, urllib.request

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc, apply = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"], os.environ.get("APPLY") == "true"

def call(method, path, body=None):
    req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
    return json.load(urllib.request.urlopen(req, timeout=60))

def fix(city):
    return re.sub(r"\bMc(\w)", lambda m: "Mc" + m.group(1).upper(), city.title())

out = {"checked": 0, "all_caps": 0, "fixed": 0, "examples": [], "error": None}
try:
    page = 1
    while True:
        res = call("POST", "/contacts/search", {"locationId": loc, "page": page, "pageLimit": 100,
                   "filters": [{"field": "tags", "operator": "contains", "value": "apify-daily-lead"}]})
        contacts = res.get("contacts", [])
        for c in contacts:
            out["checked"] += 1
            city = (c.get("city") or "").strip()
            if city and city.isupper():
                out["all_caps"] += 1
                if len(out["examples"]) < 5:
                    out["examples"].append(f"{city} -> {fix(city)}")
                if apply:
                    call("PUT", f"/contacts/{c['id']}", {"city": fix(city)})
                    out["fixed"] += 1
        if len(contacts) < 100:
            break
        page += 1
except Exception as e:
    body = e.read().decode(errors="replace")[:500] if hasattr(e, "read") else ""
    out["error"] = f"{e} {body}"
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/city_fix.json", "w"), indent=1)
print(json.dumps(out, indent=1))
