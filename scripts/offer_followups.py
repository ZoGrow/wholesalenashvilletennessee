"""Offers the agent never answered (Zack 2026-11-10: "follow up on my offers that didn't get an answer yet").
Reads stats/offers_all.json (from count-offers), looks at each agent's GHL thread, and finds offers with no
reply from the agent since. MODE=list only lists them; MODE=send texts each one a short follow-up, once
(tag offer-followed-up), skipping opted-out / DND contacts and anyone we texted in the last 24 hours.
Saves stats/offer_followups.json."""
import json, os, re, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
MODE = os.environ.get("MODE", "list")
OFFER_RE = re.compile(r"purchase price|offer on:|\b(my|our) offer\b.{0,40}\$\s?\d|\boffer(ing)? (of |is |at )?\$\s?\d"
                      r"|\$\s?\d[\d,.]*k?\s+(cash )?offer\b", re.I)
SKIP_TAGS = {"opted-out", "dnd-skipped", "bot-off", "offer-followed-up", "offer-declined", "offer-accepted"}
DONE_TAG = "offer-followed-up"

def call(method, path, body=None):
    req = urllib.request.Request(GHL + path, method=method, headers=H, data=json.dumps(body).encode() if body else None)
    for attempt in range(5):
        try:
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(2 ** attempt); continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if method == "GET" and attempt < 4:
                time.sleep(2 ** attempt); continue
            raise

def when(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))

now = datetime.now(timezone.utc)
out = []
for p in json.load(open("stats/offers_all.json")):
    cid = p["contact_id"]
    contact = call("GET", f"/contacts/{cid}").get("contact", {})
    tags = {t.lower() for t in contact.get("tags") or []}
    name = (contact.get("firstName") or p["name"]).strip().split()[0].title()
    if "staci" in p["name"].lower() and "schwittay" in p["name"].lower(): continue  # Zack: don't contact her
    convs = call("GET", f"/conversations/search?locationId={loc}&contactId={cid}").get("conversations", [])
    msgs = []
    for c in convs:
        m = call("GET", f"/conversations/{c['id']}/messages?limit=100").get("messages", {})
        msgs += m.get("messages", []) if isinstance(m, dict) else m
    msgs.sort(key=lambda x: x["dateAdded"])
    offers = [x for x in msgs if x.get("direction") == "outbound" and OFFER_RE.search(x.get("body") or "")]
    if not offers: continue
    last_offer = offers[-1]
    after = [x for x in msgs if x["dateAdded"] > last_offer["dateAdded"]]
    if any(x.get("direction") == "inbound" for x in after): continue  # they answered
    body = last_offer.get("body") or ""
    addr = (re.search(r"offer on:?\s*([^\n]+)", body, re.I) or [None, ""])[1].strip()
    street = addr.split(",")[0].strip() or "the house"
    amount = (re.search(r"purchase price:?\s*(\$[\d,]+)", body, re.I) or re.search(r"(\$\s?\d[\d,]*k?)", body) or [None, ""])[1]
    last_out = max((x["dateAdded"] for x in msgs if x.get("direction") == "outbound"), default=last_offer["dateAdded"])
    row = {"name": p["name"].title(), "contact_id": cid, "address": addr, "amount": amount,
           "offer_date": last_offer["dateAdded"][:10], "nudges_since": len([x for x in after if x.get("direction") == "outbound"]),
           "status": ""}
    no_text = bool(tags & SKIP_TAGS) or contact.get("dnd") or (contact.get("dndSettings") or {}).get("SMS", {}).get("status") == "active"
    if no_text: row["status"] = "skipped (" + ", ".join(sorted(tags & SKIP_TAGS)) + ("DND" if contact.get("dnd") else "") + ")"
    elif now - when(last_out) < timedelta(hours=24): row["status"] = "skipped (we texted in the last 24h)"
    elif MODE == "send":
        text = (f"Hey {name}, following up on my {amount} offer on {street}. "
                f"Did the seller get a chance to look at it? If they want to counter, I'm open to hearing it.")
        try:
            call("POST", "/conversations/messages", {"type": "SMS", "contactId": cid, "message": text})
            call("POST", f"/contacts/{cid}/tags", {"tags": [DONE_TAG]})
            row["status"] = "followed up"
        except Exception as e:
            row["status"] = f"send failed: {str(e)[:120]}"
        time.sleep(2)
    else:
        row["status"] = "would follow up"
    out.append(row)
    print(row["status"], "|", row["name"], "|", row["address"], row["amount"], row["offer_date"], flush=True)

os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/offer_followups.json", "w"), indent=1)
print(json.dumps({"unanswered": len(out), "followed_up": sum(r["status"] == "followed up" for r in out)}))
