"""Vendor the pieces of three.js the lodge scene needs into dist/vendor/three (imports made relative).

python tools/vendor_three.py
"""
import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "vendor" / "three"
CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/"
FILES = {
    "build/three.module.min.js": "three.module.min.js",
    "examples/jsm/loaders/GLTFLoader.js": "GLTFLoader.js",
    "examples/jsm/loaders/DRACOLoader.js": "DRACOLoader.js",
    "examples/jsm/utils/BufferGeometryUtils.js": "BufferGeometryUtils.js",
    "examples/jsm/environments/RoomEnvironment.js": "RoomEnvironment.js",
    "examples/jsm/libs/draco/gltf/draco_decoder.wasm": "draco/draco_decoder.wasm",
    "examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js": "draco/draco_wasm_wrapper.js",
}

for source, name in FILES.items():
    data = urllib.request.urlopen(urllib.request.Request(CDN + source, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read()
    if name.endswith(".js") and not name.startswith("draco/"):
        text = data.decode()
        text = re.sub(r"from 'three'", "from './three.module.min.js'", text)
        text = re.sub(r"from '\.\./utils/BufferGeometryUtils\.js'", "from './BufferGeometryUtils.js'", text)
        data = text.encode()
    target = OUT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(name, len(data) // 1024, "KB")
(OUT / "LICENSE").write_bytes(urllib.request.urlopen(urllib.request.Request(CDN + "LICENSE", headers={"User-Agent": "Mozilla/5.0"})).read())
