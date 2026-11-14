"""Write dist/_candidates.html showing Sketchfab thumbnails for a list of model uids (temporary review page)."""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
HEADERS = {"User-Agent": "Mozilla/5.0 InBudget-asset-fetch"}
cards = []
for uid in sys.argv[1:]:
    m = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://api.sketchfab.com/v3/models/{uid}", headers=HEADERS), timeout=30).read())
    thumbs = sorted(m["thumbnails"]["images"], key=lambda t: t["width"])
    thumb = next((t["url"] for t in thumbs if t["width"] >= 400), thumbs[-1]["url"])
    cards.append(f'<figure><img src="{thumb}"><figcaption>{uid[:6]} · {m["name"][:34]} · {m["faceCount"]//1000}k · {m["likeCount"]}♥</figcaption></figure>')
(ROOT / "dist" / "_candidates.html").write_text(
    '<!doctype html><meta charset="utf-8"><style>body{margin:8px;font:12px Arial;display:grid;grid-template-columns:repeat(4,1fr);gap:6px}'
    'figure{margin:0}img{width:100%;aspect-ratio:16/10;object-fit:cover}</style>' + "".join(cards), encoding="utf-8")
print(len(cards))
