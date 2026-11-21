"""Test whether email replies come back into GHL (so the bot can read photos agents email).
MODE=send: email a test contact (Zack's own address) from GHL. MODE=check: dump that conversation's
messages (type, direction, attachments) to stats/email_test.json."""
import json, os, urllib.parse, urllib.request
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
ADDR, MODE = os.environ.get("TEST_EMAIL", "zack@zogrowmedia.com"), os.environ.get("MODE", "check")
def call(method, path, body=None):
    return json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, method=method, headers=H,
        data=json.dumps(body).encode() if body else None), timeout=60))
c = call("POST", "/contacts/upsert", {"locationId": loc, "email": ADDR, "firstName": "Email", "lastName": "Test",
                                     "tags": ["bot-off", "email-test"]})["contact"]
out = {"contact": c["id"][-6:], "mode": MODE}
if MODE == "send":
    r = call("POST", "/conversations/messages", {"type": "Email", "contactId": c["id"], "subject": "Photo test (reply with a photo)",
             "emailFrom": f"Zack Olabi <{ADDR}>", "html": "Test: reply to this email with a photo attached."})
    out["sent"] = r
convs = call("GET", f"/conversations/search?{urllib.parse.urlencode({'locationId': loc, 'contactId': c['id']})}").get("conversations", [])
out["messages"] = []
for conv in convs:
    m = call("GET", f"/conversations/{conv['id']}/messages?limit=30").get("messages", {})
    for x in (m.get("messages", []) if isinstance(m, dict) else m):
        out["messages"].append({k: x.get(k) for k in ("dateAdded", "messageType", "direction", "status", "attachments", "meta", "source")})
os.makedirs("stats", exist_ok=True)
s = json.dumps(out, indent=1, default=str).replace(os.environ["GHL_TOKEN"], "***")
open("stats/email_test.json", "w").write(s); print(s)
