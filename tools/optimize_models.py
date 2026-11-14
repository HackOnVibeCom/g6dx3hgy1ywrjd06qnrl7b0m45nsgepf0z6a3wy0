"""Normalize, decimate and shrink the fetched Objaverse models into web GLBs (Blender headless).

blender -b --factory-startup -P tools/optimize_models.py -- [names]
"""
import bpy, math, pathlib, sys
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "objaverse"
OUT = ROOT / "dist" / "assets" / "models"
PREVIEW = ROOT / "assets" / "objaverse" / "previews"

# height: final model height in metres; tris: triangle budget; tex: max texture edge
MODELS = {
    "fern": dict(height=4.6, tris=30000, tex=512),
    "ridge": dict(height=5.4, tris=40000, tex=512),
    "laurel": dict(height=8.4, tris=70000, tex=512),
    "pine": dict(height=9.0, tris=4000, tex=1024),
    "firepit": dict(width=1.2, tris=4000, tex=512),
    "logs": dict(width=1.9, tris=6000, tex=512),
}
DROP = ("light", "lumen", "nail")


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def process(name, cfg):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(SRC / f"{name}.glb"))
    scene = bpy.context.scene
    for o in scene.objects:
        o.select_set(True)
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    for o in list(scene.objects):
        mats = " ".join(m.name.lower() for m in getattr(o.data, "materials", []) if m)
        if o.type != "MESH" or any(word in mats for word in DROP):
            bpy.data.objects.remove(o)
    meshes = [o for o in scene.objects if o.type == "MESH"]
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True)
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    before = tris(obj)
    if before > cfg["tris"]:
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.ratio = cfg["tris"] / before
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)

    lo, hi = bounds([obj])
    size = hi - lo
    scale = cfg["height"] / size.z if "height" in cfg else cfg["width"] / max(size.x, size.y)
    center = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for v in obj.data.vertices:
        v.co = (v.co - center) * scale
    obj.data.update()

    for img in bpy.data.images:
        w, h = img.size
        edge = max(w, h)
        if edge > cfg["tex"]:
            img.scale(max(1, w * cfg["tex"] // edge), max(1, h * cfg["tex"] // edge))

    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(target), export_format="GLB", use_selection=False,
        export_image_format="WEBP", export_image_quality=78,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
        export_lights=False, export_cameras=False, export_animations=False,
        export_yup=True, export_apply=True)
    lo, hi = bounds([obj])
    print(f"## {name}: {before} -> {tris(obj)} tris, size {tuple(round(v, 2) for v in hi - lo)}, "
          f"{len(bpy.data.images)} images, {target.stat().st_size // 1024} KB")
    preview(obj, name)


def preview(obj, name):
    scene = bpy.context.scene
    lo, hi = bounds([obj])
    radius = (hi - lo).length / 2
    mid = (lo + hi) / 2
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    direction = Vector((math.cos(math.radians(-55)), math.sin(math.radians(-55)), .45)).normalized()
    cam.location = mid + direction * radius * 2.6
    cam.rotation_euler = (mid - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (.6, .65, .7)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 640, 420
    PREVIEW.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)


names = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
for name in names or MODELS:
    process(name, MODELS[name])
