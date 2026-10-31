"""Python annotations → the kernel's `FieldType` JSON (runtime/src/function/kernel/schema.ts),
and static default values → their authored-JSON form.

FieldType kinds: number int bool string vec2 vec3 color tag entity json, enum{values},
ref{to}, list/dict/optional{of}, record{fields}. Ref targets used here:

  prefab scene placed text clip world_layer dialogue panel
  content/<kind>          a content entry of that kind
  asset                   any file under assets/
  asset/<folder>          sfx music images models vfx (SoundRef, MusicRef, ImageRef, ModelRef, EffectRef)

The kernel has no tuple, cell, quaternion or union kinds. Those annotations map to the
closest kind that still validates what it can and are listed as `approximations` in
declarations.json, never silently.
"""

from dataclasses import dataclass, field

Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]

REF_TYPES: dict[tuple[str, str], dict[str, Json]] = {
    ("parallax", "PrefabRef"): {"kind": "ref", "to": "prefab"},
    ("parallax", "SceneRef"): {"kind": "ref", "to": "scene"},
    ("parallax", "EntityRef"): {"kind": "ref", "to": "placed"},
    ("parallax", "TextRef"): {"kind": "ref", "to": "text"},
    ("parallax", "AssetRef"): {"kind": "ref", "to": "asset"},
    ("parallax", "SoundRef"): {"kind": "ref", "to": "asset/sfx"},
    ("parallax", "MusicRef"): {"kind": "ref", "to": "asset/music"},
    ("parallax", "ImageRef"): {"kind": "ref", "to": "asset/images"},
    ("parallax", "ModelRef"): {"kind": "ref", "to": "asset/models"},
    ("parallax", "EffectRef"): {"kind": "ref", "to": "asset/vfx"},
    ("parallax", "ClipRef"): {"kind": "ref", "to": "clip"},
    ("parallax", "WorldLayerRef"): {"kind": "ref", "to": "world_layer"},
    ("parallax.story", "DialogueRef"): {"kind": "ref", "to": "dialogue"},
}

VALUE_TYPES: dict[tuple[str, str], dict[str, Json]] = {
    ("parallax", "Vec2"): {"kind": "vec2"},
    ("parallax", "Vec3"): {"kind": "vec3"},
    ("parallax", "Color"): {"kind": "color"},
    ("parallax", "Tag"): {"kind": "tag"},
    ("parallax", "Entity"): {"kind": "entity"},
}

# Integer cells are written [col, row] / [x, y, z]; the kernel has no cell kind.
CELL_TYPES = {("parallax.values", "Cell"), ("parallax.values", "Cell3")}

# Live handles: valid in resources and state(), meaningless in data files, never saved.
RUNTIME_ONLY_TYPES = {("parallax", "Handle"), ("parallax", "Player"), ("parallax", "Query"),
                      ("parallax.story", "Fact")}

BUILTIN_TYPES: dict[str, dict[str, Json]] = {
    "float": {"kind": "number"},
    "int": {"kind": "int"},
    "str": {"kind": "string"},
    "bool": {"kind": "bool"},
    "Any": {"kind": "json"},
    "object": {"kind": "json"},
}

LIST_NAMES = frozenset({"list", "List", "Sequence", "MutableSequence", "Iterable", "set", "Set", "frozenset", "FrozenSet"})
DICT_NAMES = frozenset({"dict", "Dict", "Mapping", "MutableMapping"})

VEC2_CONSTANTS: dict[str, list[float]] = {
    "ZERO": [0, 0], "ONE": [1, 1], "UP": [0, 1], "DOWN": [0, -1], "LEFT": [-1, 0], "RIGHT": [1, 0],
}
VEC3_CONSTANTS: dict[str, list[float]] = {
    "ZERO": [0, 0, 0], "ONE": [1, 1, 1], "UP": [0, 1, 0], "DOWN": [0, -1, 0], "LEFT": [-1, 0, 0],
    "RIGHT": [1, 0, 0], "FORWARD": [0, 0, 1], "BACK": [0, 0, -1],
}
COLOR_CONSTANTS: dict[str, Json] = {
    "WHITE": "#ffffff", "BLACK": "#000000", "RED": "#ff0000", "GREEN": "#00ff00", "BLUE": "#0000ff",
    "YELLOW": "#ffff00", "CLEAR": [0, 0, 0, 0],
}
CELL_CONSTANTS: dict[str, list[int]] = {"UP": [0, -1], "DOWN": [0, 1], "LEFT": [-1, 0], "RIGHT": [1, 0]}
CELL3_CONSTANTS: dict[str, list[int]] = {"UP": [0, 1, 0], "DOWN": [0, -1, 0]}


@dataclass
class TypeInfo:
    type: dict[str, Json]
    localized: list[str] = field(default_factory=list)
    """Paths inside the value that hold `Localized` text: "" (the value), "[]", "title", "[].title"."""
    approximations: list[str] = field(default_factory=list)
    runtime_only: bool = False


def nest_localized(prefix: str, paths: list[str]) -> list[str]:
    out: list[str] = []
    for path in paths:
        if path == "":
            out.append(prefix)
        elif path.startswith(("[", "{")):
            out.append(f"{prefix}{path}")
        else:
            out.append(f"{prefix}.{path}" if prefix else path)
    return out
