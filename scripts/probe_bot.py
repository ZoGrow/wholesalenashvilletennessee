"""Send the SMS bot the same webhook GHL sends, for the newest contact matching a search,
and save how it answered (status, time, body) to stats/bot_probe.json."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

query, url = sys.argv[1], open("sms-bot/deployed_url.txt").read().strip()
H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28",
     "Accept": "application/json", "User-Agent": "Mozilla/5.0"}
q = urllib.parse.urlencode({"locationId": os.environ["GHL_LOCATION_ID"], "query": query, "limit": 1})
contacts = json.load(urllib.request.urlopen(urllib.request.Request(
    f"https://services.leadconnectorhq.com/contacts/?{q}", headers=H)))["contacts"]
out = {"matches": len(contacts)}
if contacts:
    c = contacts[0]
    out["tags"] = c.get("tags")
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
for k in ("GHL_TOKEN", "WEBHOOK_SECRET"):
    out = json.loads(json.dumps(out).replace(os.environ[k], "***"))
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/bot_probe.json", "w"), indent=1)
print(json.dumps(out, indent=1))
