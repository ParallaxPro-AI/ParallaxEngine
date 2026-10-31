"""Cloth and soft bodies (plugins.softbody()): flags, capes, curtains, sails and banners;
jelly, slime and balloons. Simulated on the CPU with small-step XPBD once per fixed step,
deterministic and saved in snapshots; they collide one way with the scene's sphere,
capsule, box and cylinder colliders and its terrain (they push nothing back).

Cloth hangs from its entity's origin in the entity's local x/y plane (top edge along x,
hanging toward -y, facing +z). `pin` holds an edge or corners where they lie under the
entity — attach the entity to a bone socket and the cape's top edge follows the bone:

    cape = ctx.world.spawn(Prefabs.cape)
    ctx.world.attach(cape, hero, socket="spine_upper")

    {"cloth": {"size": [0.9, 1.2], "cols": 10, "rows": 14, "pin": "top", "bend": 0.2}}

The wind (plugins.wind()) pushes cloth by its relative velocity across each triangle.

A SoftBody's entity follows the body: its position is the particles' centroid and its
rotation their best-fit rotation, so children ride along (eyes on a slime). Changing a
field that decides the particles (size, resolution, shape, mass) rebuilds it at rest.
Gravity is physics3d's (`physics3d(gravity=)`) times `gravity_scale`.
"""

from typing import Literal
from parallax import Color, EngineComponent, ImageRef, Vec2, Vec3, component, field

@component("cloth")
class Cloth(EngineComponent):
    size: Vec2 = field(Vec2(1, 1), unit="m", doc="Width (along local x) and height (hanging down).")
    cols: int = field(12, min=2, max=64, doc="Particles across.")
    rows: int = field(12, min=2, max=64, doc="Particles down.")
    pin: Literal["top", "top_corners", "left", "corners", "none"] = field("top")
    pinned: list[int] = field([], doc="More pinned particles by index (row × cols + col).")
    density: float = field(0.3, min=0.001, unit="kg/m²")
    stiffness: float = field(1, min=0, max=1, doc="Resistance to stretching (1: none).")
    bend: float = field(0.3, min=0, max=1, doc="Resistance to folding and shearing.")
    damping: float = field(0.3, min=0, doc="Share of velocity lost per second.")
    drag: float = field(1, min=0, doc="How hard the air (wind) pushes it.")
    wind_scale: float = field(1, min=0)
    gravity_scale: float = field(1)
    collide: bool = field(True)
    thickness: float = field(0.02, min=0, unit="m", doc="Distance kept from colliders.")
    friction: float = field(0.3, min=0, max=1)
    substeps: int = field(8, min=1, max=32)
    color: Color = field(Color(1, 1, 1))
    texture: ImageRef | None = field(None)
    cast_shadows: bool = field(True)

    def push(self, velocity: Vec3, *, at: Vec3 | None = None, radius: float = 0.5) -> None:
        """Change particle velocities by `velocity` (m/s, whatever their mass): every free
        particle, or with `at` those within `radius` of it, fading to the edge — a gust, a
        sword passing through."""
    def reset(self) -> None:
        """Back to the rest shape under the entity, at rest."""
    @property
    def particle_count(self) -> int: ...

@component("soft_body")
class SoftBody(EngineComponent):
    shape: Literal["sphere", "box", "capsule"] = field("sphere")
    size: Vec3 = field(Vec3(1, 1, 1), unit="m")
    detail: int = field(2, min=0, max=3, doc="Surface resolution (sphere: 12, 42, 162, 642 particles).")
    mass: float = field(1, min=0.001, unit="kg")
    stiffness: float = field(0.5, min=0, max=1, doc="Surface edges' resistance to stretching.")
    shape_stiffness: float = field(0.05, min=0, max=1, doc="Pull back to the rest shape per step: 0 water balloon, 1 rigid.")
    pressure: float = field(1, min=0.1, max=4, doc="Volume kept, times the rest volume (above 1 inflates).")
    damping: float = field(0.5, min=0)
    gravity_scale: float = field(1)
    collide: bool = field(True)
    thickness: float = field(0.01, min=0, unit="m")
    friction: float = field(0.5, min=0, max=1)
    substeps: int = field(8, min=1, max=32)
    color: Color = field(Color(0.4, 0.85, 0.4))
    texture: ImageRef | None = field(None)
    cast_shadows: bool = field(True)

    def push(self, velocity: Vec3, *, at: Vec3 | None = None, radius: float = 0.5) -> None:
        """Change particle velocities by `velocity` (m/s, whatever the mass): every particle
        (a shove, a hop), or with `at` those within `radius` of it, fading to the edge (a
        dent, a squish)."""
    def reset(self) -> None: ...
    @property
    def velocity(self) -> Vec3:
        """Mean particle velocity, m/s."""
    @property
    def volume_ratio(self) -> float:
        """Volume now over rest volume."""
