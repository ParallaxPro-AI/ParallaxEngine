"""Terrain plugin: heightfield ground declared on the scene (`"terrain": {...}` in scene.json).

The block (every key but `size` and `layers` optional; footprints are `"center": [x, z]` with
`"radius"` (circle) or `"size": [w, d]` and `"rotation"` degrees (rectangle), or
`"points": [[x, z], ...]` (polygon)):

    "terrain": {
      "size": [400, 300],               meters, centered on the origin
      "resolution": 400,                quads along the longer side (default: 1 m cells, at most 512)
      "base_height": 0,
      "max_height": 30, "seed": 4,      short form of one fBm noise layer, or:
      "noise": [{"kind": "fbm" | "ridged" | "billow", "amplitude": 30, "wavelength": 120,
                 "octaves": 5, "gain": 0.5, "lacunarity": 2, "seed": 4}],
      "hills": [{<footprint>, "height": 12, "feather": 20}],   full inside, eased out over feather
      "flats": [{<footprint>, "height": 2, "feather": 4, "mode": "set" | "carve" | "fill"}],
      "holes": [<footprint>],           ground cut away (tunnel mouths, pits)
      "water_level": 0,
      "layers": ["grass", {"name": "road", "texture": "images/road",
                 "normal": "images/road_normal", "tile": 4,
                 "tint": [1, 1, 1], "color": [0.3, 0.3, 0.3], "roughness": 0.85,
                 "detail": {"texture": "images/grain", "tile": 1.5, "strength": 0.5},
                 "pattern": "soil" | "grass" | "rock" | "sand" | "paved" | "snow",
                 "variation": 0.5, "relief": 1}],
                                        at most 8; each spot draws its 4 strongest
      "default_layer": "grass",
      "rules": [{"layer": "rock", "slope": [28, 38]}, {"layer": "snow", "height": [80, 999], "feather": 6}],
      "paint": [{"layer": "sand", <footprint>, "feather": 3, "noise": 0.4, "strength": 1}],
      "paths": [{"paint": "road", "points": [[x, z], ...], "width": 8, "feather": 1.5,
                 "closed": false, "flatten": true | {"feather": 6, "offset": 0.1}}],
                                        `paint`: the layer it paints (a path needs `paint`
                                        or `flatten`; "layer" there is an error naming it)
      "brush": [{"id": "mid_brush", <footprint>, "height": 1.6, "tags": ["lane"]}]
    }

Drawing: a textured layer tiles its image every `tile` meters, with a rotated second sample
mixed in by noise (no visible repeats) and side projection on steep ground (no stretching on
cliffs). An untextured layer is its `color` (or a tone for its name) shaded by a procedural
`pattern` (default from common layer names: grass/meadow/moss/forest/lawn/jungle → "grass",
rock/stone/cliff/gravel → "rock", sand/beach/dune/desert → "sand", road/asphalt/concrete/
pavement/tarmac → "paved", snow/ice → "snow"; any other name → "soil"). `texture` is a
project path, hosted URL, ground material name or null; `normal` (a path or URL, or null:
none) is that texture's tangent-space normal map and needs a texture; a layer named after
a ground material gets its texture and normal map unless written. `variation` (0..1) scales the mottling and large-scale tone; `relief`
(0..2) the bump from the texture or pattern. Layers meet along their surfaces' features
(height blending), and ground just above `water_level` is drawn damp.

Relief: base + noise + hills, then flats, then path grading. Splat: default layer, then
rules, then paint, then paths, each blending over what is there (later wins). Baked
deterministically: the same block gives the same ground on every machine.
"""

from parallax import Vec3

class TerrainApi:
    # Point queries read the column under `point` (its y is ignored).
    def contains(self, point: Vec3) -> bool:
        """Whether the point's column is on the terrain."""
    def height_at(self, point: Vec3) -> float:
        """The ground's height under the point."""
    def normal_at(self, point: Vec3) -> Vec3: ...
    def surface_at(self, point: Vec3) -> str:
        """The dominant material layer's name ("grass", "sand", "road") under the point."""
    def weight_at(self, point: Vec3, layer: str) -> float:
        """How much of `layer` covers the ground under the point, 0..1."""
    def ground(self, point: Vec3) -> Vec3:
        """The point dropped onto the terrain surface."""
    def is_hole(self, point: Vec3) -> bool:
        """Whether the ground under the point is cut away."""
    def brush_at(self, point: Vec3) -> str | None:
        """The id of the brush volume `point` is hidden in (inside its footprint, below its top), or None."""
    def hidden_by_brush(self, viewer: Vec3, target: Vec3) -> bool:
        """True when `target` is in a brush volume the `viewer` is not in (MOBA brush)."""

    # Deformation: saved and replayed with the game; colliders, navigation and drawing follow.
    def crater(self, center: Vec3, radius: float, *, depth: float | None = None, rim: float = 0.0, layer: str | None = None) -> None:
        """A bowl `depth` deep (default 0.4 × radius; negative raises a mound) with a raised `rim`; `layer` is painted over it."""
    def trench(self, start: Vec3, end: Vec3, width: float, depth: float, *, feather: float = 1.0, layer: str | None = None) -> None: ...
    def flatten(self, center: Vec3, radius: float, *, height: float | None = None, feather: float = 2.0) -> None:
        """Level the ground within `radius` to `height` (default: the ground at `center`)."""
    def cut_hole(self, center: Vec3, radius: float) -> None:
        """Cut the ground away (a tunnel entrance): the quads whose centers are within `radius`."""
