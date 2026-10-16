"""Read-only: save a contact's recent SMS messages with delivery status and errors to stats/contact_inspect.json."""
import json, os, sys, urllib.parse, urllib.request

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28",
     "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
GHL = "https://services.leadconnectorhq.com"
get = lambda path: json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H)))
loc = os.environ["GHL_LOCATION_ID"]
out = {"matches": []}
for c in get(f"/contacts/?{urllib.parse.urlencode({'locationId': loc, 'query': sys.argv[1], 'limit': 5})}")["contacts"]:
    full = get(f"/contacts/{c['id']}")["contact"]
    info = {"id": c["id"][-6:], "name": f"{c.get('firstName')} {c.get('lastName')}", "city": c.get("city"),
            "state": c.get("state"), "tags": full.get("tags"), "dnd": full.get("dnd"),
            "dndSettings": full.get("dndSettings"), "messages": []}
    for conv in get(f"/conversations/search?{urllib.parse.urlencode({'locationId': loc, 'contactId': c['id']})}").get("conversations", []):
        msgs = get(f"/conversations/{conv['id']}/messages?limit=10").get("messages", {})
        for m in (msgs.get("messages", []) if isinstance(msgs, dict) else msgs):
            m = {k: v for k, v in m.items() if k not in ("locationId", "contactId", "conversationId")}
            if m.get("status") in ("failed", "undelivered") and m.get("id"):
                try:
                    m["detail"] = get(f"/conversations/messages/{m['id']}")
                except Exception as e:
                    m["detail"] = str(e)
            info["messages"].append(m)
    out["matches"].append(info)
s = json.dumps(out, indent=1, default=str).replace(os.environ["GHL_TOKEN"], "***")
os.makedirs("stats", exist_ok=True)
open("stats/contact_inspect.json", "w").write(s)
print(s)
