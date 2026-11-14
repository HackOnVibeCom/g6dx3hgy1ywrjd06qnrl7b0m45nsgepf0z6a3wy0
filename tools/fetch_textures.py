"""Fetch CC0 ground textures from Poly Haven and convert them to small WebPs (needs Blender for the conversion).

python tools/fetch_textures.py
"""
import json
import pathlib
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "assets" / "polyhaven" / "textures"
OUT = ROOT / "dist" / "assets" / "models"
HEADERS = {"User-Agent": "InBudget/1.0 (asset fetch)"}
BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
TEXTURES = {"grass": "aerial_grass_rock", "soil": "rocky_terrain_02"}

CACHE.mkdir(parents=True, exist_ok=True)
jobs = []
for name, asset in TEXTURES.items():
    files = json.loads(urllib.request.urlopen(urllib.request.Request(f"https://api.polyhaven.com/files/{asset}", headers=HEADERS)).read())
    for kind, key in (("color", "Diffuse"), ("normal", "nor_gl")):
        url = files[key]["1k"]["jpg"]["url"]
        source = CACHE / f"{asset}_{kind}.jpg"
        if not source.exists():
            source.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS)).read())
        jobs.append((str(source), str(OUT / f"{name}-{kind}.webp")))

script = "import bpy\n" + "".join(
    f"img=bpy.data.images.load(r'{src}');img.scale(512,512);"
    f"s=bpy.context.scene.render.image_settings;s.file_format='WEBP';s.quality=80;"
    f"img.save_render(r'{dst}')\n" for src, dst in jobs)
subprocess.run([BLENDER, "-b", "--factory-startup", "--python-expr", script], check=True, capture_output=True)
for _, dst in jobs:
    print(dst, pathlib.Path(dst).stat().st_size // 1024, "KB")
