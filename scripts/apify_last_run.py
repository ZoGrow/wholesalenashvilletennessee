"""Save the status, input and log tail of the actor's most recent Apify runs to
stats/apify_last_run.json, so a failed daily run can be diagnosed from the repo."""
import json, os, sys, urllib.request

actor = sys.argv[1].replace("/", "~")
token = os.environ["APIFY_TOKEN"]
H = {"Authorization": f"Bearer {token}", "User-Agent": "Mozilla/5.0"}

def get(url, raw=False):
    body = urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60).read()
    return body.decode(errors="replace") if raw else json.loads(body)

out = []
for run in get(f"https://api.apify.com/v2/acts/{actor}/runs?desc=1&limit=3")["data"]["items"]:
    full = get(f"https://api.apify.com/v2/actor-runs/{run['id']}")["data"]
    ds = get(f"https://api.apify.com/v2/datasets/{full['defaultDatasetId']}")["data"]
    try:
        inp = get(f"https://api.apify.com/v2/key-value-stores/{full['defaultKeyValueStoreId']}/records/INPUT")
    except Exception as e:
        inp = str(e)
    log = get(f"https://api.apify.com/v2/actor-runs/{run['id']}/log", raw=True)
    out.append({
        "id": run["id"], "status": full["status"], "statusMessage": full.get("statusMessage"),
        "startedAt": full["startedAt"], "finishedAt": full.get("finishedAt"),
        "timeoutSecs": full.get("options", {}).get("timeoutSecs"),
        "memoryMbytes": full.get("options", {}).get("memoryMbytes"),
        "usageTotalUsd": full.get("usageTotalUsd"), "datasetItems": ds.get("itemCount"),
        "input": inp, "log_tail": log.replace(token, "***")[-4000:],
    })
out.append({"account_limits": get("https://api.apify.com/v2/users/me/limits")["data"]})
os.makedirs("stats", exist_ok=True)
json.dump(out, open("stats/apify_last_run.json", "w"), indent=1)
print(json.dumps(out, indent=1)[:6000])
