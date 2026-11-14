"""Search Sketchfab for downloadable CC models that are mirrored in Objaverse (no API key needed).

python tools/find_models.py "a-frame cabin" "log cabin" ...
"""
import gzip
import json
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADERS = {"User-Agent": "Mozilla/5.0 InBudget-asset-fetch"}
paths = json.load(gzip.open(ROOT / "assets" / "objaverse" / "object-paths.json.gz"))


def search(query, pages=3):
    url = "https://api.sketchfab.com/v3/search?" + urllib.parse.urlencode(
        {"type": "models", "q": query, "downloadable": "true", "sort_by": "-likeCount", "count": 24})
    for _ in range(pages):
        data = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30).read())
        yield from data["results"]
        url = data.get("next")
        if not url:
            break


for query in sys.argv[1:]:
    print("##", query)
    for model in search(query):
        if model["uid"] not in paths:
            continue
        license = (model.get("license") or {}).get("label", "?")
        thumbs = sorted(model["thumbnails"]["images"], key=lambda t: t["width"])
        thumb = next((t["url"] for t in thumbs if t["width"] >= 600), thumbs[-1]["url"])
        print(f'{model["uid"]} | {model["likeCount"]:5d} | {model["faceCount"]:7d} | {license} | {model["name"][:50]} | {model["user"]["username"]} | {thumb}')
