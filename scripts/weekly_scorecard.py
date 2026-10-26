"""Weekly scorecard: texts sent (stats/history.csv) and lead counts by GHL tag, compared with last week's
snapshot in stats/scorecard.csv. Posts to Slack when SLACK_WEBHOOK_URL is set."""
import csv, datetime, json, os, re, urllib.parse, urllib.request

H = {"Authorization": f"Bearer {os.environ['GHL_TOKEN']}", "Version": "2021-07-28", "Accept": "application/json",
     "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}
GHL, loc = "https://services.leadconnectorhq.com", os.environ["GHL_LOCATION_ID"]
TAGS = [("apify-daily-lead", "Agents in outreach"), ("agent-replied", "Agents who replied"),
        ("warm-lead", "Warm (something later)"), ("qualified-lead", "Qualified leads"),
        ("not-qualified", "Didn't qualify"), ("hot-lead", "Handed to you"), ("opted-out", "Opted out"),
        ("text-not-sent", "First text failed"), ("carrier-blocked", "Bot text blocked by carrier")]
SNAP = "stats/scorecard.csv"

def count(tag):
    req = urllib.request.Request(GHL + "/contacts/search", method="POST", headers=H, data=json.dumps(
        {"locationId": loc, "page": 1, "pageLimit": 10,  # GHL now rejects pageLimit 1 (400, 2026-10-26)
         "filters": [{"field": "tags", "operator": "contains", "value": tag}]}).encode())
    return int(json.load(urllib.request.urlopen(req, timeout=60)).get("total") or 0)

# Zack's offer texts, same pattern the SMS bot uses for offer follow-ups (sms-bot/src/index.ts OFFER_RE).
OFFER_RE = re.compile(r"purchase price|offer on:|\b(my|our) offer\b.{0,40}\$\s?\d|\boffer(ing)? (of |is |at )?\$\s?\d"
                      r"|\$\s?\d[\d,.]*k?\s+(cash )?offer\b", re.I)

def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(GHL + path, headers=H), timeout=60))

def lead_to_offer():
    """Zack 2026-10-26: good qualifying means ~90% of qualified leads get an offer. Returns
    (qualified, offered, names of leads with no offer yet)."""
    leads, page = [], 1
    while page <= 10:
        req = urllib.request.Request(GHL + "/contacts/search", method="POST", headers=H, data=json.dumps(
            {"locationId": loc, "page": page, "pageLimit": 100,
             "filters": [{"field": "tags", "operator": "contains", "value": "qualified-lead"}]}).encode())
        batch = json.load(urllib.request.urlopen(req, timeout=60)).get("contacts") or []
        leads += batch
        if len(batch) < 100: break
        page += 1
    offered, missing = 0, []
    for c in leads:
        found = False
        convs = get(f"/conversations/search?{urllib.parse.urlencode({'locationId': loc, 'contactId': c['id']})}")
        for conv in convs.get("conversations", []):
            msgs = get(f"/conversations/{conv['id']}/messages?limit=100").get("messages", {})
            msgs = msgs.get("messages", []) if isinstance(msgs, dict) else msgs
            found |= any(m.get("direction") == "outbound" and OFFER_RE.search(m.get("body") or "") for m in msgs)
        if found: offered += 1
        else: missing.append(" ".join(filter(None, [c.get("firstName"), c.get("lastName")])).title() or "unknown")
    return len(leads), offered, missing

today = datetime.date.today()
week_ago = today - datetime.timedelta(days=7)
sent = scraped = 0
for r in csv.DictReader(open("stats/history.csv")):
    if r["date"] > week_ago.isoformat():
        sent += int(r["sent"] or 0); scraped += int(r["scraped"] or 0)

now = {tag: count(tag) for tag, _ in TAGS}
prev = None
if os.path.exists(SNAP):
    rows = list(csv.DictReader(open(SNAP)))
    prev = rows[-1] if rows else None
PREVIEW = os.environ.get("PREVIEW") == "true"  # check the numbers without saving a snapshot or posting
new = not os.path.exists(SNAP)
with open(SNAP if not PREVIEW else os.devnull, "a", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["date"] + [t for t, _ in TAGS])
    if new: w.writeheader()
    w.writerow({"date": today.isoformat(), **now})

def line(tag, label):
    if prev and prev.get(tag) not in (None, ""):
        return f"{label}: *+{now[tag] - int(prev[tag])}* this week ({now[tag]:,} total)"
    return f"{label}: {now[tag]:,} total"

replied_week = now["agent-replied"] - int(prev["agent-replied"]) if prev and prev.get("agent-replied") else None
replied_rate = f"{replied_week / sent:.1%} of this week's texts" if replied_week is not None and sent else "starts next week"
try:
    q, o, missing = lead_to_offer()
    offer_line = (f"🎯 Qualified leads you made an offer on: *{o} of {q}* ({o / q:.0%}, goal 90%)" if q else
                  "🎯 Qualified leads you made an offer on: no qualified leads yet")
    if missing:
        offer_line += f"\nNo offer yet: {', '.join(missing[:8])}{' and more' if len(missing) > 8 else ''}"
except Exception as e:
    offer_line = f"🎯 Lead-to-offer rate: couldn't check ({e})"
text = "\n\n".join([
    f"📈 *Weekly scorecard* (week ending {today:%b %-d})",
    f"📤 Texts sent: *{sent:,}* (from {scraped:,} agents scraped, {now['apify-daily-lead']:,} agents texted all-time)",
    "\n".join(line(t, l) for t, l in TAGS[1:6]),
    f"Reply rate: {replied_rate}",
    offer_line,
    "\n".join(line(t, l) for t, l in TAGS[6:]),
])
print(text)
open("stats/scorecard_preview.txt" if PREVIEW else "stats/scorecard_latest.txt", "w").write(text)
if os.environ.get("SLACK_WEBHOOK_URL") and not PREVIEW:
    urllib.request.urlopen(urllib.request.Request(os.environ["SLACK_WEBHOOK_URL"], method="POST",
        headers={"Content-Type": "application/json"}, data=json.dumps({"text": text}).encode()), timeout=30)
