"""Weekly scorecard: texts sent (stats/history.csv) and lead counts by GHL tag, compared with last week's
snapshot in stats/scorecard.csv. Posts to Slack when SLACK_WEBHOOK_URL is set."""
import csv, datetime, json, os, urllib.request

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
        {"locationId": loc, "page": 1, "pageLimit": 1,
         "filters": [{"field": "tags", "operator": "contains", "value": tag}]}).encode())
    return int(json.load(urllib.request.urlopen(req, timeout=60)).get("total") or 0)

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
new = not os.path.exists(SNAP)
with open(SNAP, "a", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["date"] + [t for t, _ in TAGS])
    if new: w.writeheader()
    w.writerow({"date": today.isoformat(), **now})

def line(tag, label):
    if prev and prev.get(tag) not in (None, ""):
        return f"{label}: *+{now[tag] - int(prev[tag])}* this week ({now[tag]:,} total)"
    return f"{label}: {now[tag]:,} total"

replied_week = now["agent-replied"] - int(prev["agent-replied"]) if prev and prev.get("agent-replied") else None
replied_rate = f"{replied_week / sent:.1%} of this week's texts" if replied_week is not None and sent else "starts next week"
text = "\n\n".join([
    f"📈 *Weekly scorecard* (week ending {today:%b %-d})",
    f"📤 Texts sent: *{sent:,}* (from {scraped:,} agents scraped, {now['apify-daily-lead']:,} agents texted all-time)",
    "\n".join(line(t, l) for t, l in TAGS[1:6]),
    f"Reply rate: {replied_rate}",
    "\n".join(line(t, l) for t, l in TAGS[6:]),
])
print(text)
open("stats/scorecard_latest.txt", "w").write(text)
if os.environ.get("SLACK_WEBHOOK_URL"):
    urllib.request.urlopen(urllib.request.Request(os.environ["SLACK_WEBHOOK_URL"], method="POST",
        headers={"Content-Type": "application/json"}, data=json.dumps({"text": text}).encode()), timeout=30)
