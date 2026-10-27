"""Send one SMS from Zack's GHL number to a contact (found by name or phone). Used when Zack asks
Claude to text someone back by hand."""
import json, os, sys, urllib.parse, urllib.request
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
query, text = sys.argv[1], sys.argv[2]
cs = json.load(urllib.request.urlopen(urllib.request.Request(
    f"{GHL}/contacts/?{urllib.parse.urlencode({'locationId': loc, 'query': query, 'limit': 2})}", headers=H)))["contacts"]
if len(cs) != 1: sys.exit(f"expected 1 contact for {query!r}, found {len(cs)}")
c = cs[0]
if c.get("dnd") or "opted-out" in (c.get("tags") or []): sys.exit("contact is DND/opted out, not texting")
r = json.load(urllib.request.urlopen(urllib.request.Request(f"{GHL}/conversations/messages", method="POST", headers=H,
    data=json.dumps({"type": "SMS", "contactId": c["id"], "message": text}).encode())))
print("sent", c.get("firstName"), r.get("messageId"))
