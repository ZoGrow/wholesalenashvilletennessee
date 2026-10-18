"""Add (or with a leading "-", remove) tags on the first outreach contact matching a search:
python scripts/tag_contact.py "<name or phone>" tag1,-tag2"""
import json, os, sys, urllib.parse, urllib.request

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
q = urllib.parse.urlencode({"locationId": loc, "query": sys.argv[1], "limit": 5})
contacts = json.load(urllib.request.urlopen(urllib.request.Request(f"{GHL}/contacts/?{q}", headers=H)))["contacts"]
c = next((c for c in contacts if "apify-daily-lead" in (c.get("tags") or [])), None)
if not c:
    sys.exit(f"no outreach contact matches {sys.argv[1]!r}")
tags = [t.strip() for t in sys.argv[2].split(",") if t.strip()]
add, remove = [t for t in tags if not t.startswith("-")], [t[1:] for t in tags if t.startswith("-")]
for method, batch in (("POST", add), ("DELETE", remove)):
    if batch:
        urllib.request.urlopen(urllib.request.Request(f"{GHL}/contacts/{c['id']}/tags", method=method, headers=H,
                                                      data=json.dumps({"tags": batch}).encode()))
print("contact", c.get("firstName"), c.get("lastName"), "added", add, "removed", remove)
