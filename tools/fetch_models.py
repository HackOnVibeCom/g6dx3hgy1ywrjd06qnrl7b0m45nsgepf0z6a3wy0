"""Download chosen Sketchfab models from the Objaverse mirror and record their attribution.

python tools/fetch_models.py
"""
import gzip
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "objaverse"
HEADERS = {"User-Agent": "Mozilla/5.0 InBudget-asset-fetch"}
MIRROR = "https://huggingface.co/datasets/allenai/objaverse/resolve/main/"

MODELS = {
    "fern": "459f2d5fa81f44d1a006962072e59187",
    "ridge": "526b1eb74e054baf9e25f00a8cd1bc81",
    "laurel": "2657189dbdff49fdb20ba33d6ebd5c52",
    "pine": "dc3fbd9205cf4027a4455d1f415e0478",
    "firepit": "9490039432e94536b05ac5bd3406ed61",
    "logs": "3f4205a30a7d4adda50c775fb8cce06c",
}

paths = json.load(gzip.open(OUT / "object-paths.json.gz"))
credits = {}
for name, uid in MODELS.items():
    target = OUT / f"{name}.glb"
    if not target.exists():
        print("fetching", name)
        data = urllib.request.urlopen(urllib.request.Request(MIRROR + paths[uid], headers=HEADERS), timeout=600).read()
        target.write_bytes(data)
    meta = json.loads(urllib.request.urlopen(urllib.request.Request(
        f"https://api.sketchfab.com/v3/models/{uid}", headers=HEADERS), timeout=30).read())
    credits[name] = {
        "title": meta["name"],
        "author": meta["user"]["displayName"] or meta["user"]["username"],
        "license": (meta.get("license") or {}).get("label", "?"),
        "url": meta["viewerUrl"],
    }
    print(name, target.stat().st_size // 1024, "KB", credits[name]["license"], credits[name]["author"])
(OUT / "credits.json").write_text(json.dumps(credits, indent=2))
