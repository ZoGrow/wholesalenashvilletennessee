"""Read-only: every outbound GHL text that looks like one of Zack's offers, across all conversations.
Saves stats/offers_all.json (per-agent list with date, amount, text) and prints totals."""
import json, os, re, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
# Same pattern as weekly_scorecard.py / sms-bot OFFER_RE.
OFFER_RE = re.compile(r"purchase price|offer on:|\b(my|our) offer\b.{0,40}\$\s?\d|\boffer(ing)? (of |is |at )?\$\s?\d"
                      r"|\$\s?\d[\d,.]*k?\s+(cash )?offer\b", re.I)
MONEY = re.compile(r"\$\s?\d[\d,.]*\s?k?", re.I)

def get(path):
    for attempt in range(6):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H), timeout=60))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 5:
                time.sleep(2 ** attempt); continue
            raise

convs, after = [], None
while True:
    q = {"locationId": loc, "limit": 100, "sortBy": "last_message_date", "sort": "desc"}
    if after: q["startAfterDate"] = after
    batch = get("/conversations/search?" + urllib.parse.urlencode(q)).get("conversations", [])
    if not batch: break
    convs += batch
    after = batch[-1].get("lastMessageDate")
    if not after or len(batch) < 100: break
print(len(convs), "conversations")

def scan(c):
    m = get(f"/conversations/{c['id']}/messages?limit=100").get("messages", {})
    ms = m.get("messages", []) if isinstance(m, dict) else m
    hits = [x for x in ms if x.get("direction") == "outbound" and OFFER_RE.search(x.get("body") or "")]
    if not hits: return None
    return {"name": c.get("fullName") or c.get("contactName") or "", "contact_id": c.get("contactId"),
            "offers": [{"date": x["dateAdded"][:10], "amount": (MONEY.findall(x.get("body") or "") or [""])[0],
                        "text": (x.get("body") or "")[:300]} for x in sorted(hits, key=lambda x: x["dateAdded"])]}

with ThreadPoolExecutor(6) as ex:
    out = [r for r in ex.map(scan, convs) if r]
out = [r for r in out if "olabi" not in r["name"].lower()]
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/offers_all.json", "w"), indent=1)
print(json.dumps({"agents_with_offer": len(out), "offer_texts": sum(len(r["offers"]) for r in out)}))
