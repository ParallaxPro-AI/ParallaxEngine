"""Per-entity data: the survivor's build, the horde, and what flies or lies on the floor."""

from enum import Enum

from parallax import ContentRef, Vec3, component, field, record, tag
from parallax.physics import Layers as PhysicsLayers, layer

from game.content import EnemyDef

Horde = tag("horde")
Elite = tag("elite")
"""Ash Wardens: the HUD's boss bar follows them."""
SurvivorSide = tag("side_survivor")
HordeSide = tag("side_horde")
CinderShard = tag("cinder_shard")


@component("build")
class Build:
    """The survivor's current numbers. Base values live in the survivor prefab; drafts and
    shrine perks change them during a run. (Move speed is `Character.walk_speed`.)"""
    damage: float = field(12)
    fire_interval: float = field(0.5, unit="s")
    bolts: int = field(1, doc="Bolts per volley, each at its own target.")
    pierce: int = field(0)
    hit_radius: float = field(1, unit="m")
    bolt_speed: float = field(34, unit="m/s")
    bolt_range: float = field(34, unit="m")
    pickup_radius: float = field(5.5, unit="m")
    nova_cooldown: float = field(10, unit="s")
    nova_ready_at: float = field(0, unit="s", doc="Game time the Ember Nova can fire again.")
    nova_radius: float = field(14, unit="m")
    dash_ready_at: float = field(0, unit="s", doc="Game time the dash charge is back.")
    dash_cooldown: float = field(1.6, unit="s", doc="The last dash's recharge, for the HUD.")
    nova_damage: float = field(90)
    xp_mul: float = field(1)
    aura_dps: float = field(0)
    aura_radius: float = field(0, unit="m")
    lifesteal: float = field(0, doc="Health per kill.")
    revives: int = field(0)


@component("foe")
class Foe:
    """A horde member's kind and its stats after the surge's scaling."""
    kind: ContentRef[EnemyDef] = field()
    damage: float = field()
    speed: float = field(unit="m/s")


@component("bolt")
class Bolt:
    velocity: Vec3 = field()
    damage: float = field()
    pierce: int = field(0)
    hit_radius: float = field(1, unit="m")


@component("soul_mote")
class SoulMote:
    xp: float = field()


@component("shot")
class Shot:
    """A spitter's cinder shard in flight."""
    velocity: Vec3 = field()
    damage: float = field()


class Layers(PhysicsLayers):
    survivor = layer()
    shard = layer()
    pickup = layer()
    wall = layer()


class Motion(Enum):
    SPIN = "spin"
    OSCILLATE = "oscillate"


@record
class JointMove:
    """One joint kept moving forever: `spin` turns a free hinge once per `period`;
    `oscillate` eases between `low` and `high` (0..1 of the joint's limits) and back."""
    joint: str = field()
    mode: Motion = field(Motion.OSCILLATE)
    period: float = field(3, unit="s", min=0.01)
    low: float = field(0, min=0, max=1)
    high: float = field(1, min=0, max=1)
    phase: float = field(0, min=0, max=1)


@component("ambient_motion")
class AmbientMotion:
    """Idle life on a decor model: the banner's cloth, the forge's bellows and flames, the
    altar's rings and runes."""
    moves: list[JointMove] = field([])
