"""Procedural geometry from data (plugins.procgen()): paths swept into roads, rails,
coasters, pipes and race tracks; buildings from character-grid floor plans;
seeded dungeons with locks and keys, dressed from prop kits.

Everything is a component on an entity, built from its fields — deterministic, rebuilt
when the fields change (assigning a field: at once; editing inside a list, like one plan
row: within a few frames), and not otherwise touched, so a scene of generators costs
nothing per frame. Drawn by the renderer and solid to physics (`collide`):

    # A road: a closed spline with a slab, striped kerbs both sides and auto-banking (a whole
    # circuit — kerbs on corners, run-off, barriers, stands, gantry — is a Track instead).
    {"spline": {"points": [[0, 0, 0], [80, 0, 20], ...], "closed": true, "auto_bank": 6},
     "sweep": {"parts": [{"profile": "road", "width": 12},
                         {"profile": "kerb", "offset": [6.5, 0], "mirror": true,
                          "stripe": 2, "colors": ["#e0453f", "#f2ece0"]}]}}

Paths are a service too: racing AI, lap counters and minimaps ask the Spline
(`entity.get(Spline).nearest(car_position)`) — distance along the lap, lateral offset,
the heading there — instead of keeping their own waypoint lists.

Coordinates are the entity's local space (the entity's transform places it); frames: x is
right of travel and y is up, +z forward at yaw 0.
"""

from typing import Literal
from parallax import (
    Color, EngineComponent, Entity, PrefabRef, Vec2, Vec3, component, content, field, record,
)


# ─────────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────────

class PathPoint:
    """A point on a path, world space."""
    distance: float
    """Meters from the start."""
    point: Vec3
    tangent: Vec3
    """Unit direction of travel."""
    right: Vec3
    """Unit, right of travel, rolled by the bank."""
    up: Vec3
    bank: float
    """Degrees of roll (positive: the right side is lower)."""

class PathHit(PathPoint):
    """The nearest point of a path to a query point."""
    lateral: float
    """Signed meters along `right` from the centerline to the query point."""
    offset: float
    """Meters from the query point to the centerline."""

@component("spline")
class Spline(EngineComponent):
    """A curve through control points in the entity's local space, sampled by arc length.

    curve: "catmull_rom" passes through every point (centripetal: no loops on uneven
        spacing); "bezier" is anchor, handle, handle, anchor, … (3k + 1 points open, 3k
        closed); "linear" joins them straight.
    frame: "level" keeps sections upright (roads, tracks); "transport" follows loops and
        corkscrews without flipping (coasters, tubes), the closing twist spread evenly.
    bank: degrees per control point (anchor), smoothly interpolated; auto_bank adds lean
        into turns: `auto_bank` degrees at a turn of radius `bank_radius`, more for tighter
        turns up to ±auto_bank.
    ground="terrain": every sample sits `lift` meters above the scene's terrain.
    """
    points: list[Vec3] = field([])
    closed: bool = field(False)
    curve: Literal["catmull_rom", "bezier", "linear"] = field("catmull_rom")
    frame: Literal["level", "transport"] = field("level")
    bank: list[float] = field([], doc="Degrees per control point; empty: none.")
    auto_bank: float = field(0, doc="Degrees of lean at a turn of bank_radius.")
    bank_radius: float = field(20, unit="m")
    spacing: float = field(1, unit="m", doc="Most meters between samples.")
    ground: Literal["none", "terrain"] = field("none")
    lift: float = field(0.05, unit="m")
    def length(self) -> float:
        """Meters along the path (world space)."""
    def sample(self, distance: float) -> PathPoint:
        """The point `distance` meters along (wrapped on closed paths, clamped on open ones)."""
    def nearest(self, point: Vec3) -> PathHit:
        """The nearest centerline point: distance along, lateral offset, heading there."""
    def progress(self, point: Vec3) -> float:
        """0..1 along the path of the nearest point (lap progress)."""
    def polyline(self, spacing: float | None = None) -> list[Vec3]:
        """World points along the path (the samples, or every `spacing` meters): minimaps, guides."""

@record
class SweepPart:
    """One profile swept along the Spline (a part of the Sweep). Built-in profiles: road (slab, top at y = 0),
    ribbon (top face only), kerb, wall, rail (a pair, gauge = width), tube (outward), pipe
    (inward: ride inside), channel (half pipe, inward); or a `profile` content entry."""
    profile: str = field("road")
    width: float | None = field(None, unit="m", doc="None: the profile's own (road 8, kerb 1, wall 0.3, rail 1.5, tube 1, pipe 4, channel 3).")
    height: float | None = field(None, unit="m")
    offset: Vec2 = field(Vec2(0, 0), doc="Meters right and up from the centerline.")
    mirror: bool = field(False, doc="Also on the other side (offset.x negated, the profile mirrored).")
    color: Color = field(Color.hex("#7a7a7a"))
    colors: list[Color] = field([], doc="With `stripe`: bands cycling these colors.")
    stripe: float | None = field(None, unit="m", doc="Band length along the path.")
    texture: str = field("")
    uv_length: float = field(4, unit="m", doc="Meters per texture repeat along the path.")
    uv_width: float | None = field(None, unit="m", doc="Across the profile; None: uv_length.")
    start: float = field(0, unit="m")
    end: float | None = field(None, unit="m", doc="None: the whole path.")
    caps: bool = field(False, doc="Close a closed profile's ends on an open path.")
    collide: bool = field(True)
    shadows: bool = field(True)
    double_sided: bool = field(False)
    roughness: float = field(0.85, min=0, max=1)
    metallic: float = field(0, min=0, max=1)

@component("sweep")
class Sweep(EngineComponent):
    """Profiles swept along this entity's Spline (it needs one)."""
    parts: list[SweepPart] = field([SweepPart()])

@record
class TrackSurface:
    """The tarmac."""
    color: Color = field(Color.hex("#4a4a52"))
    texture: str = field("", doc="Tarmac image, repeating every `tile` meters.")
    tile: float = field(6, unit="m")
    roughness: float = field(0.72, min=0, max=1)
    crown: float = field(0.1, unit="m", doc="Centerline rise over the edges (at most width / 4).")

@record
class TrackEdgeLines:
    """Painted lines along both tarmac edges."""
    width: float = field(0.22, unit="m")
    inset: float = field(0.3, unit="m", doc="From the tarmac edge.")
    color: Color = field(Color.hex("#f2ece0"))

@record
class TrackKerbs:
    """Striped kerbs. Corners are where the centerline turns tighter than `radius`, run
    `extend` meters before and after: on="corners" lines both sides there, "apex" the
    inside only, "full" the whole lap, "none" no kerbs."""
    on: Literal["corners", "apex", "full", "none"] = field("corners")
    width: float = field(1.1, unit="m")
    height: float = field(0.11, unit="m")
    stripe: float = field(2.2, unit="m", doc="Band length along the track.")
    colors: list[Color] = field([Color.hex("#e0453f"), Color.hex("#f2ece0")])
    radius: float = field(120, unit="m", doc="Turns tighter than this are corners.")
    extend: float = field(12, unit="m", doc="Corners run this far before and after.")

@record
class TrackRunoff:
    """The verge beyond the kerbs; its outer edge sits on the ground."""
    kind: Literal["gravel", "grass", "tarmac", "none"] = field("gravel")
    width: float = field(3.5, unit="m")
    color: Color | None = field(None, doc="None: the kind's own.")

@record
class TrackBarrier:
    """An armco rail on posts every `post_every` m, or a concrete wall (striped when
    `colors` has several), `gap` beyond the run-off; tyre walls stack on the outside of
    the tighter corners, around the apex."""
    kind: Literal["armco", "wall", "none"] = field("armco")
    gap: float = field(0.5, unit="m", doc="From the run-off's edge.")
    height: float = field(0.75, unit="m")
    colors: list[Color] = field([], doc="Empty: steel / concrete; several: a striped wall.")
    post_every: float = field(4, unit="m")
    collide: bool = field(True, doc="Barriers, tyre walls, gantry towers and stands are solid.")
    tyre_walls: bool = field(True)
    tyre_colors: list[Color] = field([Color.hex("#1d1d1f"), Color.hex("#f2ece0")])

@record
class TrackCrowd:
    """Stepped stands of seeded, code-built spectators, `setback` behind the barrier."""
    sections: list[Vec2] = field([], doc="Lap fractions [from, to] (to < from wraps over the start).")
    side: Literal["both", "left", "right"] = field("both")
    rows: int = field(4, min=1, max=40)
    row_gap: float = field(0.9, unit="m")
    row_rise: float = field(0.45, unit="m", doc="Step height of the stands.")
    density: float = field(1.1, doc="Spectators per meter per row.")
    setback: float = field(2, unit="m", doc="From the barrier to the front row.")
    max: int = field(1200, min=0)
    stands: bool = field(True, doc="False: spectators stand on the ground.")
    stand_color: Color = field(Color.hex("#8d8a84"))
    colors: list[Color] = field([], doc="Shirt colors; empty: a ten-color palette.")

@record
class TrackGantry:
    """Towers and a beam with banners and five start lights over the start line."""
    color: Color = field(Color.hex("#1f3a6b"))

@record
class TrackSigns:
    """Trackside boards, alternating sides."""
    every: float = field(0, unit="m", doc="0: none.")
    colors: list[Color] = field([])

@record
class TrackGrade:
    """How the terrain under a Track (spline ground="terrain") is graded: flat across,
    eased along, back to the land over `feather` meters."""
    feather: float = field(10, unit="m")
    paint: str | None = field(None, doc="A terrain layer painted under road, kerbs and run-off (terrain.surface_at and foliage `avoid` see it).")

@component("track")
class Track(EngineComponent):
    """A race track built along this entity's Spline (it needs one; give it
    `ground="terrain"` and the terrain under it is graded — the road, run-off and barriers
    sit on it). Every part has defaults, so a circuit is a few keys:

        {"spline": {"points": [[478.8, 0, 106.6], ...], "closed": true, "ground": "terrain",
                    "spacing": 3, "auto_bank": 4, "bank_radius": 60},
         "track": {"crowd": {"sections": [[0, 0.1], [0.92, 1]]}, "signs": {"every": 120},
                   "grade": {"paint": "road"}}}

    Cross-section, centerline outwards: crowned tarmac (`width`, `surface`) with painted
    `edge_lines` → `kerbs` → `runoff` → `barrier` → `crowd` stands. The `gantry` and the
    chequered `finish_line` stand `start` meters along. `edge_lines`, `gantry` or `grade`
    set to None leaves that part out.

    Solid (`collide`): tarmac and kerbs; barriers, tyre walls, gantry towers and stands
    when `barrier.collide`. Same data, same track: rebuilt when a field changes.
    """
    width: float = field(18, unit="m", doc="Tarmac, edge to edge.")
    start: float = field(0, unit="m", doc="Start/finish line, meters along the spline.")
    surface: TrackSurface = field(TrackSurface())
    edge_lines: TrackEdgeLines | None = field(TrackEdgeLines())
    kerbs: TrackKerbs = field(TrackKerbs())
    runoff: TrackRunoff = field(TrackRunoff())
    barrier: TrackBarrier = field(TrackBarrier())
    crowd: TrackCrowd = field(TrackCrowd())
    gantry: TrackGantry | None = field(TrackGantry())
    finish_line: bool = field(True, doc="The chequered strip across the road at `start`.")
    signs: TrackSigns = field(TrackSigns())
    grade: TrackGrade | None = field(TrackGrade())
    seed: int = field(0, doc="Crowd variety.")
    collide: bool = field(True)
    def racing_line(self, spacing: float | None = None) -> list[Vec3]:
        """World points of a racing line: inside at each apex, outside before and after,
        1.5 m inside the edges (the samples, or every `spacing` meters). AI steer along it."""
    def surface_at(self, point: Vec3) -> str:
        """"road", "kerb", "runoff" or "off": what is under `point` (by its nearest centerline point)."""
    def corners(self) -> list[Vec2]:
        """Each corner's (start, end) meters along the spline (start can be negative across the start line)."""

@content("profile")
class ProfileDef:
    """A custom sweep outline (content/profile/<id>.json): x right, y up, meters (scaled by
    the sweep part's width and height). Each segment faces its right-hand side: closed outlines
    run counter-clockwise; an open top surface runs right to left."""
    points: list[Vec2]
    closed: bool = field(False)
    smooth: bool = field(False, doc="Shared normals across corners (round profiles).")
    width: float = field(1, doc="The sweep part's default width.")
    height: float = field(1)


# ─────────────────────────────────────────────────────────────────────────────
# Materials
# ─────────────────────────────────────────────────────────────────────────────

@record
class ProcMaterial:
    color: Color = field(Color.hex("#9a9a9a"))
    texture: str = field("")
    normal_map: str = field("", doc="Tangent-space normal map, tiled like the texture (Structures, Dungeons).")
    tile: float = field(1, unit="m", doc="Meters per texture repeat.")
    roughness: float = field(0.85, min=0, max=1)
    metallic: float = field(0, min=0, max=1)


# ─────────────────────────────────────────────────────────────────────────────
# Structures
# ─────────────────────────────────────────────────────────────────────────────

@record
class StructureFloor:
    """One storey of text rows. Text rows read like a map: the first row is the top (+z on
    the ground), rows run toward -z, and columns run along +x. Every storey's first row is
    on the same +z edge. The characters are Structure's table: `#` wall, `|` glass wall,
    `+` door, `_` arch, `=` window, `>` `<` `^` `v` stairs, `.` or space void, a letter or
    digit a room (4-connected groups of one character are one room; a `legend` entry makes
    any other unreserved character a room too, and an unknown character is PP3650).
    Openings sit in wall lines; a run of `+` is one wide door.

    Stairs: a rectangle of one arrow is one flight up to the next storey, climbing the way
    the arrow points on the map: `>` +x, `<` -x, `^` +z (up the page), `v` -z. It needs room cells at its foot, room cells
    over it on the storey above (the stairwell: that slab is left out) and past its head
    there to step out onto; steps of about 18 cm divide the storey
    exactly, and the run's length is the going (at most 50°: a 3 m storey wants about 4
    cells of 1 m). Solid, so characters walk up them. On the top floor a flight needs
    `Roof(kind="flat", access=True)`: it climbs the storey plus the deck's slab onto
    the roof, which is left open over it; the cells past its head are the landing.

        # A two-storey house: hall with a flight up to the landing (l) above it.
        StructureFloor(plan=["#########",
                             "#hhhhhhh#",
                             "#h>>>>>h#",
                             "#hhhhhhh#",
                             "####+####"]),
        StructureFloor(plan=["#########",
                             "#lllllll#",
                             "#lllllll#",
                             "#lllllll#",
                             "#########"])
    """
    plan: list[str] = field([])
    height: float = field(3, unit="m", doc="Storey height, slab included.")

@record
class RoomStyle:
    name: str = field("", doc="The room's id (default: its character).")
    floor: str = field("floor", doc="Material key (Structure.materials) of its floor.")
    height: float | None = field(None, unit="m", doc="Its wall height where nothing is built over it (a low annex; a double-height hall under void); None: the storey's. Walls rise to their tallest neighbouring room.")

class GeneratedRoom:
    id: str
    name: str
    role: str
    """Structures: "room". Dungeons: "entrance", "room", "key", "objective", "treasure"."""
    floor: int
    center: Vec3
    """World point on the floor at the room's most central cell."""
    area: float
    critical: bool
    """Dungeons: on the entrance → objective path."""
    region: int
    """Dungeons: how many locks lie between it and the entrance."""

class GeneratedDoor:
    kind: str
    """"door", "arch", "window" (structures); "door" or "gate" (dungeons)."""
    position: Vec3
    """World point at the bottom center of the opening."""
    yaw: float
    """Degrees: facing across the opening, from rooms[0] to rooms[1]."""
    width: float
    rooms: list[str]
    """The rooms on each side ("outside" for void)."""
    lock: int | None

class GeneratedStair:
    """A flight of a Structure, from `floor` up to floor + 1."""
    floor: int
    bottom: Vec3
    """World point at the middle of the foot of the flight."""
    top: Vec3
    """World point at the middle of its head, on the storey above."""
    yaw: float
    """Degrees: the direction of climb."""
    width: float
    steps: int

@record
class Shutters:
    """A leaf either side of every exterior window, open and flat against the wall."""
    width: float = field(0.5, min=0.1, max=1, doc="Leaf width, as a fraction of the window's half width.")
    levels: list[int] | None = field(None, doc="Storeys (0 is the ground floor); None: every storey.")

@record
class Mullions:
    """Vertical bars through every exterior window: as many as keep each pane under `spacing`."""
    spacing: float = field(1.2, unit="m", min=0.2)
    width: float = field(0.06, unit="m", min=0.01)
    levels: list[int] | None = field(None, doc="Storeys; None: every storey.")

@record
class Awnings:
    """A cloth canopy over exterior openings, raked out and down, with a valance."""
    on: Literal["windows", "doors", "all"] = field("windows")
    depth: float = field(1.1, unit="m", min=0.2, doc="Out from the wall face.")
    drop: float = field(0.25, unit="m", doc="How far the leading edge hangs below the wall edge.")
    rise: float = field(0.15, unit="m", doc="The wall edge, above the opening's head.")
    levels: list[int] | None = field(None, doc="Storeys; None: every storey.")

@record
class Balconies:
    """A slab with a rail on three sides in front of exterior openings, 25 cm wider each side."""
    on: Literal["windows", "doors", "all"] = field("windows")
    depth: float = field(1, unit="m", min=0.2)
    rail: float = field(0.95, unit="m", doc="Rail height; 0: none.")
    levels: list[int] | None = field(None, doc="Storeys; None: every storey above the ground floor.")

@record
class Roof:
    """A Structure's roof, over every cell with nothing built above it: "flat" slabs, or
    per rectangle of one height a "gable" (ridge along the longer side), "hip" or "shed"
    at `pitch` with `overhang` of eave; "none" leaves it open to the sky. A flat roof can
    be played: `access` lets the top floor's flights climb onto the deck (left open over
    each flight), `parapet` raises the exterior walls above it, `coping` caps them."""
    kind: Literal["flat", "gable", "hip", "shed", "none"] = field("gable")
    pitch: float = field(30, doc="Degrees.")
    overhang: float = field(0.3, unit="m")
    access: bool = field(False, doc="Flat roofs: top-floor flights climb onto the deck.")
    parapet: float = field(0, unit="m", min=0, doc="Flat roofs: wall above the deck over the exterior walls; 0: none.")
    coping: bool = field(False, doc="Cap the parapet (oversails 5 cm).")

@record
class Facade:
    """Exterior dressing (wall faces towards the outside only): a `plinth` base course on
    the ground storey, broken at doors and arches, and per opening `shutters`,
    `mullions`, `awnings` and `balconies`. Plinths and balconies are solid; shutters,
    mullions and awnings are not."""
    plinth: float = field(0, unit="m", min=0, doc="Base course height; 0: none.")
    shutters: Shutters | None = field(None)
    mullions: Mullions | None = field(None)
    awnings: Awnings | None = field(None)
    balconies: Balconies | None = field(None)

@component("structure")
class Structure(EngineComponent):
    r"""A building from floor plans, centered on the entity, floors stacked from y = 0:
    slabs, walls, lintels over doors, sills/heads and glass for windows, glass walls,
    stairs and the roof. Everything is one trimesh: every room, stair and roof deck is a
    floor characters walk and nav agents path on (each flight is also a nav link).

    Draw the storeys in a `.plan` text file (`plan`) or inline (`floors`). A plan file is
    the rows of each storey under a `--- <height>` line (bottom storey first), then an
    optional `--- legend` of `<char> <room> [<floor material>] [<height>]` lines (one word
    each; material default "floor"). The file has no comment lines. Rows are a map seen
    from above: the first row is the +z edge, columns run along +x, one `cell` square each.

    Characters (the engine's one table, plan.ts PLAN_CHARACTERS):

        #        wall
        |        glass wall
        +        door (a run of + is one wider door)
        _        arch (an opening as tall as the wall, no door)
        =        window
        > < ^ v  stairs climbing towards +x, -x, +z (up the page), -z (down the page)
        . space  void (outside, nothing built)

    Any letter or digit (but `v`) is a room (each 4-connected group of one character is
    one room); any other character is a room only with a legend entry, else PP3653; a
    legend entry for a reserved character is an error. A rectangle of one arrow is one
    flight to the storey above, climbing the way the arrow points — nothing is inferred
    (`/` and `\` from older plans are errors that say so). Openings sit between solid
    walls along a row or a column. A flight needs a room cell at its foot, room cells on
    the storey above over every stair cell (the stairwell) and just past its head (the
    landing), and at most 50° of pitch: about 6 cells of 0.5 m for a 3.4 m storey; aim
    for 35-40°.

    buildings/shop.plan (cell=0.5): a shop with a flight up near the +z wall, and a
    flight onto the flat roof (rise = storey + slab) climbing back the other way:

        --- 3.4
        ############
        #ssssssssss#
        #s>>>>>>>>s#
        #s>>>>>>>>s#
        #ssssssssss+
        #ssssssssss#
        #####==#####
        --- 3.4
        ############
        #uuuuuuuuuu=
        #uuuuuuuuuu#
        #uuuuuuuuuu#
        #u<<<<<<<<u#
        #u<<<<<<<<u#
        #####==#####
        --- legend
        s shop tile
        u upper boards

        # The style, once (a prefab); each placement names its plan and its plaster.
        Structure(plan="buildings/shop.plan", cell=0.5, door_height=2.1,
                  roof=Roof(kind="flat", access=True, parapet=0.75, coping=True),
                  facade=Facade(plinth=0.55, mullions=Mullions(), awnings=Awnings(levels=[0])),
                  materials={"wall": ProcMaterial(texture="assets/images/plaster.jpg", tile=3.2)},
                  colors={"wall": Color.hex("#f3ecdf")})

    Glass is see-through: give "glass" a translucent color (alpha below 1); windows are
    open to physics, glass walls are solid. `materials` keys: "wall" (parapets too),
    "roof", "slab", "glass", "stair", "plinth", "coping", "balcony", "shutter",
    "mullion", "awning" and each room's floor key; another key is PP3652. A key left out
    falls back ("slab" → "wall", "stair" → "slab", "plinth"/"coping"/"balcony" → "roof"),
    then to a plain default. `colors` recolours a key without restating its material (a
    placement's own plaster over its prefab's). door_prefab is spawned in every door;
    `kit` dresses every room. Builds are cached by content: an unchanged building isn't
    rebuilt on a scene reload or hot reload."""
    plan: str | None = field(None, doc="A project-relative .plan file; instead of `floors`.")
    floors: list[StructureFloor] = field([])
    legend: dict[str, RoomStyle] = field({}, doc="Adds to (and overrides) the plan file's legend.")
    materials: dict[str, ProcMaterial] = field({})
    colors: dict[str, Color] = field({}, doc="Material key → color, over `materials` (and the key's fallback).")
    cell: float = field(1, unit="m")
    slab: float = field(0.2, unit="m")
    door_height: float = field(2.2, unit="m")
    window_sill: float = field(0.9, unit="m")
    window_height: float = field(1.2, unit="m")
    roof: Roof = field(Roof())
    facade: Facade = field(Facade())
    door_prefab: PrefabRef | None = field(None)
    kit: str | None = field(None, doc="A prop_kit content id.")
    seed: int = field(0, doc="Dressing rolls.")
    collide: bool = field(True)
    layer: str = field("default", doc="Collision layer of the generated geometry (a name from physics3d(layers=...)): what raycasts and characters filtering by layer hit.")
    def rooms(self) -> list[GeneratedRoom]: ...
    def doors(self) -> list[GeneratedDoor]:
        """Doors, arches and windows."""
    def stairs(self) -> list[GeneratedStair]:
        """Flights between storeys: AI "go upstairs" targets, spawn points."""
    def room_at(self, point: Vec3) -> GeneratedRoom | None: ...


# ─────────────────────────────────────────────────────────────────────────────
# Dungeons
# ─────────────────────────────────────────────────────────────────────────────

@component("dungeon")
class Dungeon(EngineComponent):
    """A dungeon from a seed: a mission (regions behind `locks` locked doors, each key in
    the region before its lock, an objective room at the end, treasure rooms off the main
    path, `loops` extra corridors within regions), laid out on a room lattice (corridors
    never cross, so locks can't be bypassed), built as floor and wall boxes (`tile` meters
    per tile), and populated: key_prefab in each key room, gate_prefab in each locked
    door, objective / treasure prefabs at those rooms' centers, `enemies` enemy_prefab in
    every room but the entrance, and `kit` dressing. Spawned entities are children of this
    one and carry GeneratedPiece. Same data, same dungeon.
    `materials` keys: "floor", "wall", "ceiling"."""
    seed: int = field(0)
    rooms: int = field(10, min=3, max=200)
    locks: int = field(0, min=0)
    treasures: int = field(1, min=0)
    loops: int = field(0, min=0)
    room_min: int = field(5, min=3, doc="Room side in tiles.")
    room_max: int = field(9, max=64)
    corridor: int = field(2, min=1, doc="Corridor width in tiles (at most room_min - 2).")
    tile: float = field(2, unit="m")
    wall_height: float = field(4, unit="m")
    ceiling: bool = field(False)
    materials: dict[str, ProcMaterial] = field({})
    kit: str | None = field(None, doc="A prop_kit content id.")
    key_prefab: PrefabRef | None = field(None)
    gate_prefab: PrefabRef | None = field(None)
    door_prefab: PrefabRef | None = field(None, doc="In every unlocked doorway (room-clear doors).")
    objective_prefab: PrefabRef | None = field(None)
    treasure_prefab: PrefabRef | None = field(None)
    enemy_prefab: PrefabRef | None = field(None)
    enemies: int = field(0, min=0, doc="Per room, the entrance excepted.")
    collide: bool = field(True)
    layer: str = field("default", doc="Collision layer of the generated geometry (a name from physics3d(layers=...)): what raycasts and characters filtering by layer hit.")
    def rooms(self) -> list[GeneratedRoom]: ...
    def doors(self) -> list[GeneratedDoor]:
        """Doorways; locked ones are kind "gate" with their lock index."""
    def entrance(self) -> Vec3:
        """Where the player starts: the entrance room's center (world)."""
    def room_at(self, point: Vec3) -> GeneratedRoom | None: ...

@component("generated_piece")
class GeneratedPiece(EngineComponent):
    """On every entity a Structure or Dungeon spawned (kept by the engine): which generator,
    what it is ("door", "gate", "key", "objective", "treasure", "enemy", "prop"), its room
    and, for keys and gates, the lock index. Pieces are rebuilt when the generator's data
    changes."""
    source: Entity | None = field(None)
    role: str = field("")
    room: str = field("")
    lock: int | None = field(None)


# ─────────────────────────────────────────────────────────────────────────────
# Prop kits
# ─────────────────────────────────────────────────────────────────────────────

@record
class KitProp:
    prefab: PrefabRef
    place: Literal["center", "corner", "wall", "floor"] = field("floor")
    weight: float = field(1, min=0)
    radius: float = field(0.5, min=0, unit="m", doc="Footprint: props never overlap.")
    scale: tuple[float, float] = field((1, 1), doc="Random uniform scale range.")

@content("prop_kit")
class PropKitDef:
    """Room dressing (content/prop_kit/<id>.json). A room gets up to
    min(max_per_room, density · area / 100) props: a center prop (rooms with nothing else
    there), corner props, wall props every wall_step meters facing in, then floor scatter;
    `inset` from the walls, `clearance` from doors and the room center, seeded."""
    props: list[KitProp]
    density: float = field(6, doc="Props per 100 m².")
    max_per_room: int = field(12)
    wall_step: float = field(3, unit="m")
    clearance: float = field(1.5, unit="m")
    inset: float = field(0.8, unit="m")
