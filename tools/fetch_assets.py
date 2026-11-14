"""Download optimized CC0 1.0 PBR 3D models and environment maps from tevy.dev into dist/assets/models/."""
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "assets" / "models"
HEADERS = {"User-Agent": "InBudget-AssetFetch/2.1 (CC0 PBR fast-LOD pipeline)"}

ASSETS = [
    ("fern-hollow-cabin.glb", "https://tevy.dev/models/sauna/v2/lod1.glb", "Nordic Timber Cabin (Sauna v2, LOD1)", "https://tevy.dev/models/sauna"),
    ("ridge-house.glb", "https://tevy.dev/models/red-cottage/v2/lod1.glb", "Falu Red Country Cottage (v2, LOD1)", "https://tevy.dev/models/red-cottage"),
    ("laurel-lodge.glb", "https://tevy.dev/models/medieval-tavern/v1/lod1.glb", "Stone & Timber Mountain Lodge (v1, LOD1)", "https://tevy.dev/models/medieval-tavern"),
    ("spruce.glb", "https://tevy.dev/models/young-spruce/v1/lod2.glb", "Young Spruce Conifer (v1, LOD2)", "https://tevy.dev/models/young-spruce"),
    ("mossy-rocks.glb", "https://tevy.dev/models/mossy-rocks/v1/lod2.glb", "Mossy Forest Rocks (v1, LOD2)", "https://tevy.dev/models/mossy-rocks"),
    ("bracken-fern.glb", "https://tevy.dev/models/bracken-fern/v1/lod2.glb", "Bracken Fern Cluster (v1, LOD2)", "https://tevy.dev/models/bracken-fern"),
    ("campfire.glb", "https://tevy.dev/models/campfire-ring/v1/lod2.glb", "Stone Campfire Ring (v1, LOD2)", "https://tevy.dev/models/campfire-ring"),
    ("lantern.glb", "https://tevy.dev/models/storm-lantern/v1/lod2.glb", "Warm Storm Lantern (v1, LOD2)", "https://tevy.dev/models/storm-lantern"),
    ("golden-hour-sky.jpg", "https://tevy.dev/skies/golden-hour/1k.jpg", "Golden Hour Sky Panorama", "https://tevy.dev/skies/golden-hour"),
]


def main(force=False):
    OUT.mkdir(parents=True, exist_ok=True)
    credits = []
    for filename, url, title, page in ASSETS:
        dest = OUT / filename
        if force or not dest.exists():
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as resp:
                dest.write_bytes(resp.read())
        credits.append({
            "file": filename,
            "title": title,
            "url": url,
            "source": page,
            "license": "CC0 1.0 Universal",
        })
        print(f"ok {filename} ({dest.stat().st_size // 1024} KB)")
    (ROOT / "dist" / "assets" / "credits.json").write_text(json.dumps(credits, indent=2) + "\n")


if __name__ == "__main__":
    import sys
    main(force="--refresh" in sys.argv)
