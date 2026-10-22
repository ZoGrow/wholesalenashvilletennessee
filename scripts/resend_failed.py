"""Resend outreach texts GHL failed to deliver because the account hit its opt-out/error limit:
first texts and workflow follow-ups from the last few days. One text per contact (the earliest
blocked one that never got through), skipping DND, opted-out, replied and handed-off contacts.
MODE=count only counts; MODE=send resends, throttled, and stops as soon as the limit error returns
or it gets late in Central time. Summary saved to stats/resend_failed.json."""
import urllib.error, json, os, time, urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import Counter

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
MODE, LIMIT = os.environ.get("MODE", "count"), int(os.environ.get("LIMIT", "100"))
LIMIT_ERR = "opt-out/error limit"  # only resend texts blocked by the account limit, not bad numbers
SINCE = (datetime.now(timezone.utc) - timedelta(days=int(os.environ.get("DAYS", "3")))).isoformat()
SKIP = {"opted-out", "dnd-skipped", "hot-lead", "bot-off", "agent-replied", "qualified-lead", "not-qualified"}

def call(method, path, body=None):
    req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise

def messages(cid):
    convs = call("GET", f"/conversations/search?locationId={loc}&contactId={cid}").get("conversations", [])
    if not convs: return None, []
    m = call("GET", f"/conversations/{convs[0]['id']}/messages?limit=20").get("messages", {})
    m = m.get("messages", []) if isinstance(m, dict) else m
    return convs[0]["id"], sorted([x for x in m if x.get("messageType") == "TYPE_SMS" or x.get("type") == 2],
                                  key=lambda x: x["dateAdded"])

contacts, page = [], 1
while True:
    res = call("POST", "/contacts/search", {"locationId": loc, "page": page, "pageLimit": 100,
               "filters": [{"field": "tags", "operator": "contains", "value": "apify-daily-lead"}]})
    contacts += res.get("contacts", [])
    if len(res.get("contacts", [])) < 100: break
    page += 1

out = {"mode": MODE, "tagged": len(contacts), "eligible": 0, "skipped": Counter(), "errors": Counter(),
       "sent": 0, "delivered": 0, "failed_again": 0, "kinds": Counter(), "stopped_early": None}
fails_in_row = 0
for c in contacts:
    tags = {t.lower() for t in c.get("tags") or []}
    if "apify-daily-lead" not in tags: out["skipped"]["not outreach"] += 1; continue
    if tags & SKIP: out["skipped"]["tag " + sorted(tags & SKIP)[0]] += 1; continue
    if c.get("dnd") or (c.get("dndSettings") or {}).get("SMS", {}).get("status") == "active":
        out["skipped"]["dnd"] += 1; continue
    conv, ms = messages(c["id"])
    if not ms: out["skipped"]["no messages"] += 1; continue
    if any(m["direction"] == "inbound" for m in ms): out["skipped"]["they replied"] += 1; continue
    # Anything not failed counts as got (incl. pending/queued), so a text another run just sent isn't sent again.
    got = {m.get("body") for m in ms if m["direction"] == "outbound" and m.get("status") not in ("failed", "undelivered")}
    failed = [m for m in ms if m["direction"] == "outbound" and m.get("status") in ("failed", "undelivered")
              and m.get("body") and m["body"] not in got and m["dateAdded"] >= SINCE]
    if not failed: continue
    err = failed[0].get("error") or "none"
    # If an earlier resend of this text already bounced off a dead number, don't keep retrying it.
    dead = [m.get("error") or "" for m in ms if m["direction"] == "outbound" and m.get("body") == failed[0]["body"]
            and m.get("status") in ("failed", "undelivered") and LIMIT_ERR not in (m.get("error") or "").lower()]
    if dead: err = dead[0] or err
    out["errors"][err[:90]] += 1
    if LIMIT_ERR not in err.lower(): out["skipped"]["bad number (" + err[:20] + ")"] += 1; continue
    kind = "first text" if not got else "follow-up"
    out["eligible"] += 1; out["kinds"][kind] += 1
    if datetime.now(ZoneInfo("America/Chicago")).hour >= 20:
        out["stopped_early"] = out["stopped_early"] or "8pm Central, too late to text"; continue
    if MODE != "send" or out["sent"] >= LIMIT: continue
    try:
        sent = call("POST", "/conversations/messages", {"type": "SMS", "contactId": c["id"], "message": failed[0]["body"]})
    except urllib.error.HTTPError as e:  # one contact GHL won't text (e.g. turned DND) shouldn't end the whole run
        out["skipped"][f"GHL refused send (HTTP {e.code})"] += 1
        continue
    out["sent"] += 1
    time.sleep(8)
    m = next((x for x in messages(c["id"])[1] if x.get("id") == sent.get("messageId")), {})
    if m.get("status") in ("failed", "undelivered"):
        out["failed_again"] += 1; fails_in_row += 1
        out["errors"]["RESEND: " + (m.get("error") or "none")[:80]] += 1
        if LIMIT_ERR in (m.get("error") or "").lower():
            out["stopped_early"] = "opt-out/error limit hit again"; break
        elif any(code in (m.get("error") or "") for code in ("30003", "30005", "30006", "30008")):
            fails_in_row -= 1  # a dead or unreachable number isn't a sign we're being blocked; keep going
        if fails_in_row >= 5:
            out["stopped_early"] = "5 resends in a row failed"; break
    else:
        fails_in_row = 0
        out["delivered"] += 1
        if "text-not-sent" in tags: call("DELETE", f"/contacts/{c['id']}/tags", {"tags": ["text-not-sent"]})
    time.sleep(4)
out["skipped"], out["errors"], out["kinds"] = dict(out["skipped"]), dict(out["errors"].most_common(8)), dict(out["kinds"])
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/resend_failed.json", "w"), indent=1)
print(json.dumps(out, indent=1))
