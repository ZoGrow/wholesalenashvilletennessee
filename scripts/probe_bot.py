"""Send the SMS bot the same webhook GHL sends, for the newest contact matching a search,
and save how it answered (status, time, body) to stats/bot_probe.json."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

query, url = sys.argv[1], open("sms-bot/deployed_url.txt").read().strip()
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28",
     "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
GHL = "https://services.leadconnectorhq.com"
get = lambda path: json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H)))
loc = os.environ["GHL_LOCATION_ID"]
contacts = get(f"/contacts/?{urllib.parse.urlencode({'locationId': loc, 'query': query, 'limit': 10})}")["contacts"]
out = {"matches": []}
best = None
for c in contacts:
    info = {"id": c["id"][-6:], "tags": c.get("tags"), "messages": []}
    convs = get(f"/conversations/search?{urllib.parse.urlencode({'locationId': loc, 'contactId': c['id']})}")
    for conv in convs.get("conversations", []):
        msgs = get(f"/conversations/{conv['id']}/messages?limit=5").get("messages", {})
        msgs = msgs.get("messages", []) if isinstance(msgs, dict) else msgs
        info["messages"] += [{k: m.get(k) for k in ("direction", "messageType", "type", "status", "dateAdded")}
                             for m in msgs]
    if any(m["direction"] == "inbound" for m in info["messages"]) and best is None:
        best = c
    out["matches"].append(info)
c = best
if c:
    out["probed"] = c["id"][-6:]
    req = urllib.request.Request(f"{url}/?key={os.environ['WEBHOOK_SECRET']}", method="POST",
                                 data=json.dumps({"contact_id": c["id"]}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    t = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=120)
        out.update(status=r.status, body=r.read().decode()[:2000])
    except urllib.error.HTTPError as e:
        out.update(status=e.code, body=e.read().decode(errors="replace")[:2000])
    except Exception as e:
        out.update(status="no answer", body=str(e))
    out["seconds"] = round(time.time() - t, 1)
    notes = get(f"/contacts/{c['id']}/notes").get("notes", [])
    out["notes"] = [{"at": n.get("dateAdded"), "body": (n.get("body") or "")[:600]} for n in notes[:5]]
    full = get(f"/contacts/{c['id']}")["contact"]
    out["tags_now"] = full.get("tags")
for k in ("GHL_TOKEN", "WEBHOOK_SECRET"):
    out = json.loads(json.dumps(out).replace(os.environ[k], "***"))
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/bot_probe.json", "w"), indent=1)
print(json.dumps(out, indent=1))
