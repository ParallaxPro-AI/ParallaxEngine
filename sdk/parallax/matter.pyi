"""Stuff that cuts, heats, melts, boils and pours (plugins.matter()): soft solids you can
slice with real cut faces, heat with real heat transfer, and liquids that fill containers,
boil, swirl when stirred and spill when tipped. List it after physics3d.

Sliceable — a soft solid drawn from a shape (a wax block, a clay rod, a gel slab, a foam
brick). Give the entity a dynamic Rigidbody and a Collider for it to fall, stack and ride
in trays; its soft layer sags, squashes on landing and wobbles (`softness` 0 firm … 1 gel)
on top of that rigid motion. `slice(point, normal)` cuts it along a world plane into two
closed pieces with cut faces: this entity keeps the side the normal points away from, a
copy (the same prefab with every component's current values and tags) gets the other and
is returned. Each piece's mass follows its volume (`density`) and its box collider is
fitted to it (`fit_collider`). A cut face is drawn from `inner_edge_color` at its rim to
`inner_color` in its middle — a block heated on one side and cut open shows the scorched
band and its untouched middle.

    {"sliceable": {"shape": "box", "size": [0.12, 0.04, 0.09], "round": 0.008,
                   "color": "#d8c79a", "inner_color": "#efe3c0", "pattern": 0.12, "softness": 0.25}}

    piece = block.get(Sliceable).slice(blade_point, blade_side)   # Entity | None
    block.get(Sliceable).stain(0.02, facing=vec3(0, -1, 0))       # scorch the side on the hot plate

Thermal — heat in a body: a surface and a core temperature (°C). The surface exchanges heat
with the air, with touching Thermal bodies (physics contacts), with HeatSources and with the
liquid it sits in; the core warms by conduction through the body's thickness, so a thick
block scorches outside long before its middle warms. Water in the surface (`moisture`)
holds it at 100 °C while it boils off (`evaporating`: a hiss); a `melt_point` melts
(`melted` 0..1) and sets again, taking and giving back `latent_heat` (wax, solder, ice).

HeatSource — `surface`: a hot plate or heating element; heats the lowest Thermal body inside
its `zone` (what sits on it) through `conductance` from `temperature`, at most `power` ×
`level`. `air`: a furnace or kiln; a thermostatted air volume (`air_temperature`) heating
everything in the zone. `volumetric`: `power` × `level` straight into the Thermal bodies
and liquids in the zone, by mass and moisture (induction or dielectric heating).

Liquid — liquid in a container whose interior is a frustum along local +y (`radius` at
`floor`, `top_radius` at the rim, `depth` tall). `volume` (liters) sets the level; the
surface stays level as the container tilts, sloshes when it jerks, swirls when stirred
(`stir`, carrying floating and sunken pieces round), bubbles as it nears and reaches
`boil_point` (boiling off volume), and spills over the rim's lowest point into the liquid
container below (or onto the floor: `spilled`). Its own `temperature` exchanges with the
container's Thermal and with what is in it.
"""

from typing import Literal
from parallax import Color, EngineComponent, Entity, Vec3, component, field

@component("sliceable")
class Sliceable(EngineComponent):
    shape: Literal["box", "sphere", "cylinder", "capsule"] = field("box", doc="Cylinder and capsule stand along local y.")
    size: Vec3 = field(Vec3(0.1, 0.1, 0.1), unit="m", doc="Full extents.")
    round: float = field(0.01, min=0, unit="m", doc="Edge rounding (box, cylinder).")
    taper: float = field(1, min=0.05, max=4, doc="Width at +y over width at -y (a tapered rod: 0.3).")
    bump: float = field(0, min=0, max=0.3, doc="Surface unevenness.")
    segments: int = field(8, min=2, max=16, doc="Mesh resolution.")
    seed: int = field(0)
    color: Color = field(Color(0.8, 0.3, 0.3), doc="Skin. Alpha below 1 draws it see-through (gel, ice).")
    color_variation: float = field(0.12, min=0, max=1)
    inner_color: Color = field(Color(0.9, 0.5, 0.5), doc="Cut faces, in the middle.")
    inner_edge_color: Color = field(Color(0.9, 0.5, 0.5), doc="Cut faces, at the rim.")
    inner_edge: float = field(0, min=0, max=1, doc="Share of a cut face (rim inward) in inner_edge_color.")
    pattern_color: Color = field(Color(1, 1, 1), doc="Specks on cut faces (grain, inclusions).")
    pattern: float = field(0, min=0, max=1, doc="Share of cut-face vertices in pattern_color.")
    stain_color: Color = field(Color(0.55, 0.3, 0.12), doc="Stain 0.7: scorched.")
    char_color: Color = field(Color(0.08, 0.06, 0.05), doc="Stain 1: charred.")
    roughness: float = field(0.6, min=0, max=1)
    softness: float = field(0.2, min=0, max=1, doc="0 firm (hard wax) … 1 gel.")
    damping: float = field(3, min=0, doc="Share of wobble velocity lost per second.")
    density: float = field(1000, min=0, unit="kg/m³", doc="The Rigidbody's mass follows the volume; 0 keeps it.")
    fit_collider: bool = field(True, doc="Fit the box collider to each piece after a cut.")
    min_piece: float = field(2e-6, min=0, unit="m³", doc="A cut that would leave less on either side does nothing.")
    cast_shadows: bool = field(True)

    def slice(self, point: Vec3, normal: Vec3) -> Entity | None:
        """Cut along the world plane through `point` facing `normal`. Returns the new piece
        (the side `normal` points to), or None when the plane misses or leaves a sliver."""
    def push(self, velocity: Vec3, *, at: Vec3 | None = None, radius: float = 0.05) -> None:
        """Change soft-layer velocities (m/s) — every particle, or near `at`: a dent, a poke."""
    def stain(self, amount: float, *, facing: Vec3 | None = None, at: Vec3 | None = None, radius: float = 0.05) -> None:
        """Darken by `amount` (0..1 scale: 0.7 scorched, 1 charred) where the surface faces
        the world direction `facing` and/or lies within `radius` of `at`. Negative lightens."""
    def paint(self, color: Color, amount: float, *, coverage: float = 1, facing: Vec3 | None = None,
              at: Vec3 | None = None, radius: float = 0.05) -> None:
        """Blend a colour on (dirt, soot, pigment); `coverage` below 1 paints that share as specks."""
    def clean(self, amount: float) -> None:
        """Wash paint off: every paint weight falls by `amount`."""
    def stain_level(self, facing: Vec3 | None = None) -> float:
        """Mean stain (0..1), of the surface facing a world direction if given (both sides scorched?)."""
    def reset(self) -> None:
        """Back to the whole, unstained shape its fields describe."""
    @property
    def stain_max(self) -> float: ...
    @property
    def paint_level(self) -> float:
        """Mean paint weight (0..1): how dirty it still is."""
    @property
    def volume(self) -> float:
        """m³ of this piece."""
    @property
    def cuts(self) -> int:
        """How many cuts made this piece."""
    @property
    def cut_share(self) -> float:
        """Share (0..1) of the surface that is cut face."""
    @property
    def extents(self) -> Vec3:
        """The piece's size (m) in its own frame."""
    @property
    def deformation(self) -> float:
        """m: how far it is squashed or wobbling right now."""

@component("thermal")
class Thermal(EngineComponent):
    temperature: float = field(20, unit="°C", doc="The surface.")
    core: float = field(20, unit="°C", doc="The middle.")
    mass: float = field(0, min=0, unit="kg", doc="0: the Rigidbody's mass (or the Sliceable's volume × density).")
    specific_heat: float = field(3500, min=1, unit="J/(kg·K)", doc="Wax ~2900, water 4186, steel 500, oil 2000, ice 2100.")
    conductivity: float = field(0.5, min=0, unit="W/(m·K)", doc="Through the body: wood ~0.15, wax ~0.25, ice 2.2, steel 50.")
    surface_share: float = field(0.25, min=0.05, max=0.95, doc="Share of the heat capacity in the surface.")
    contact: float = field(300, min=0, unit="W/(m²·K)", doc="Heat transfer to touching bodies.")
    air: float = field(10, min=0, unit="W/(m²·K)", doc="Heat transfer to the air.")
    moisture: float = field(0, min=0, max=1, doc="Water in the surface layer (kg/kg); boils off above 100 °C.")
    melt_point: float | None = field(None, unit="°C")
    latent_heat: float = field(0, min=0, unit="J/kg")
    melted: float = field(0, min=0, max=1)
    @property
    def heating(self) -> float:
        """W into the body over the last step (negative: cooling)."""
    @property
    def evaporating(self) -> float:
        """kg/s of surface water boiling off: how loud it hisses."""

@component("heat_source")
class HeatSource(EngineComponent):
    kind: Literal["surface", "air", "volumetric"] = field("surface")
    temperature: float = field(600, unit="°C", doc="Flame or element (surface); thermostat (air).")
    power: float = field(2000, min=0, unit="W")
    level: float = field(0, min=0, max=1, doc="0 off … 1 full.")
    conductance: float = field(10, min=0, unit="W/K", doc="surface: to what sits on it, at full level.")
    coefficient: float = field(25, min=0, unit="W/(m²·K)", doc="air: to what is inside.")
    zone: Vec3 = field(Vec3(0.25, 0.08, 0.25), unit="m", doc="The box it heats, in its own frame.")
    zone_offset: Vec3 = field(Vec3(0, 0.04, 0), unit="m")
    air_temperature: float = field(20, unit="°C", doc="air: the furnace's air now.")

@component("liquid")
class Liquid(EngineComponent):
    volume: float = field(0, min=0, unit="L")
    radius: float = field(0.1, min=0.005, unit="m", doc="Interior radius at the floor.")
    top_radius: float = field(0, min=0, unit="m", doc="At the rim; 0: same as radius.")
    depth: float = field(0.15, min=0.002, unit="m")
    floor: float = field(0.005, unit="m", doc="Local y of the interior floor.")
    kind: str = field("water")
    color: Color = field(Color(0.55, 0.68, 0.78, 0.55))
    temperature: float = field(20, unit="°C")
    boil_point: float = field(100, unit="°C")
    specific_heat: float = field(4186, min=1, unit="J/(kg·K)")
    density: float = field(1, min=0.01, unit="kg/L")
    viscosity: float = field(0, min=0, max=1, doc="0 water … 1 glycerin (slosh and swirl die faster).")
    coefficient: float = field(600, min=0, unit="W/(m²·K)", doc="To what is in it (boiling water ~600, a hot oil bath ~300).")
    wall: float = field(800, min=0, unit="W/(m²·K)", doc="To the container's Thermal.")
    swirl: float = field(0, unit="rad/s")
    spilled: float = field(0, min=0, unit="L", doc="Total that missed every container.")

    def add(self, liters: float, *, temperature: float | None = None, color: Color | None = None, kind: str | None = None) -> None:
        """Pour in, mixing temperature and colour by volume."""
    def remove(self, liters: float) -> float:
        """Take out up to `liters`; returns what was taken."""
    def stir(self, speed: float) -> None:
        """Spin it: rad/s added to `swirl` (positive counter-clockwise from above)."""
    def pour_into(self, other: Entity, liters: float) -> float:
        """Move liters into another entity's Liquid; returns what moved."""
    def holds(self, entity: Entity) -> bool:
        """Whether the entity is in the liquid."""
    @property
    def level(self) -> float:
        """World height of the surface (m)."""
    @property
    def fill(self) -> float:
        """Volume over capacity."""
    @property
    def capacity(self) -> float:
        """Liters to the rim."""
    @property
    def boiling(self) -> float:
        """0..1: how hard it boils."""
    @property
    def near_boil(self) -> float:
        """0..1: how near the boil."""
    @property
    def pouring(self) -> float:
        """L/s spilling over the rim."""
    @property
    def pour_point(self) -> Vec3:
        """The lip it spills from."""

class MatterApi:
    """`ctx.matter`: the air temperature and how fast heat runs."""
    ambient: float
    time_scale: float
