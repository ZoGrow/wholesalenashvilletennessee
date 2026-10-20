"""Try an Apify actor on a small sample and save a summary of its output shape
(field names, phone formats and labels, counts) to stats/actor_test.json.
No names, numbers or emails are saved: digits and letters in values are masked."""
import json, os, re, sys, urllib.error, urllib.request
from collections import Counter

actor, run_input = sys.argv[1], json.loads(sys.argv[2])
url = (f"https://api.apify.com/v2/acts/{actor.replace('/', '~')}/run-sync-get-dataset-items"
       f"?token={os.environ['APIFY_TOKEN']}&timeout=280")
req = urllib.request.Request(url, data=json.dumps(run_input).encode(),
                             headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
try:
    items = json.load(urllib.request.urlopen(req, timeout=300))
except urllib.error.HTTPError as e:
    os.makedirs("stats", exist_ok=True)
    body = e.read().decode(errors="replace").replace(os.environ["APIFY_TOKEN"], "***")[:2000]
    json.dump({"actor": actor, "input": run_input, "error": f"HTTP {e.code}", "body": body},
              open("stats/actor_test.json", "w"), indent=1)
    print(body)
    sys.exit(0)

def mask(v):
    if isinstance(v, dict):
        return {k: mask(x) for k, x in v.items()}
    if isinstance(v, list):
        return [mask(x) for x in v[:3]]
    if isinstance(v, str):
        return re.sub(r"[A-Za-z]", "a", re.sub(r"\d", "9", v))[:60]
    return v

fields, phone_labels, shapes = Counter(), Counter(), []
with_phone = 0
for it in items:
    fields.update(k for k, v in it.items() if v not in (None, "", [], {}))
    phones = it.get("phones") or it.get("phoneNumbers") or []
    if isinstance(phones, dict):
        phones = [{"type": k, "number": v} for k, v in phones.items()]
    if phones or it.get("phone") or it.get("primaryPhone"):
        with_phone += 1
    for p in phones if isinstance(phones, list) else []:
        if isinstance(p, dict):
            phone_labels[str(p.get("type") or p.get("label") or p.get("phoneType") or "(none)").lower()] += 1
        else:
            phone_labels["(plain string)"] += 1

os.makedirs("stats", exist_ok=True)
json.dump({
    "actor": actor, "input": run_input, "items": len(items), "with_any_phone": with_phone,
    "phone_labels": dict(phone_labels), "fields_filled": dict(fields.most_common()),
    "sample_shapes": [mask(it) for it in items[:2]],
    # property fields (no personal data) kept as-is, for checking Zillow lookups
    "property_values": [{k: it.get(k) for k in ("address", "streetAddress", "zestimate", "price", "homeStatus",
                         "rentZestimate", "url", "hdpUrl", "livingArea", "yearBuilt") if k in it} for it in items[:3]],
}, open("stats/actor_test.json", "w"), indent=1)
print(open("stats/actor_test.json").read()[:3000])
