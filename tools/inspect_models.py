import bpy, pathlib, sys
from mathutils import Vector

ROOT = pathlib.Path(sys.argv[-2])
names = sys.argv[-1].split(",")


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


for name in names:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / f"{name}.glb"))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print("==", name)
    rows = []
    for o in meshes:
        lo, hi = bounds([o])
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        rows.append(((hi - lo).length, o.name, tris, tuple(round(v) for v in hi - lo), tuple(round(v) for v in lo), [m.name for m in o.data.materials]))
    for r in sorted(rows, reverse=True)[:14]:
        print("  ", r[1], r[2], r[3], r[4], r[5])
