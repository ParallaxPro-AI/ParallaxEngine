"""Per-entity data. The Wisp's petals (lives), dewshields and i-frames are the combat
plugin's `Health` (`current`, `shield`, `protect`)."""

from parallax import ContentRef, Entity, Timer, Vec2, component, field

from game.content import BloomDef, GuardianDef, Gun, WaveDef


@component("wisp")
class Wisp:
    """The Wisp's build and arsenal. The build stats are `modifiable`: each shrine
    attunement stacks a modifier on one (see `game.build.attune`), so reading a stat
    gives the stock value from the prefab with every attunement applied."""
    fire_gap: float = field(1.0, modifiable=True, doc="Multiplies the gun's gap between shots.")
    spark_damage: float = field(1.0, modifiable=True)
    spark_speed: float = field(16.0, unit="m/s", modifiable=True)
    twin: float = field(0, modifiable=True, doc="Above 0, the gun fires two sparks abreast.")
    move_speed: float = field(8.5, unit="m/s", modifiable=True)
    wave_shields: float = field(0, modifiable=True, doc="Dewshields granted as every wave starts.")
    pickup_radius: float = field(0.8, unit="m", modifiable=True)
    drop_bonus: float = field(0, modifiable=True, doc="Added to every wave's drop chance.")
    graze_gain: float = field(1.0, modifiable=True, doc="Spirit per graze.")
    max_bombs: float = field(3, modifiable=True)
    invulnerability: float = field(1.3, unit="s", modifiable=True, doc="I-frames after a hit.")

    bombs: int = field(2, min=0)
    spirit: float = field(0.0, min=0)
    gun: Gun = field(Gun.SINGLE)
    gun_time: Timer = field(Timer.cooldown(0), doc="A bloom gun reverts to SINGLE when this runs out.")
    focusing: bool = field(False)


@component("guardian")
class Guardian:
    kind: ContentRef[GuardianDef] = field()
    wave: ContentRef[WaveDef] = field()
    slot: int = field(0, doc="Its place in the wave's formation.")


@component("drift")
class Drift:
    """Straight-line motion for sparks and petals (see `Motion`)."""
    velocity: Vec2 = field(Vec2.ZERO, unit="m/s")


@component("spark")
class Spark:
    """One of the Wisp's seed-sparks."""
    pierce: bool = field(False, doc="Passes through guardians, hitting each once.")
    struck: list[Entity] = field([])


@component("petal")
class Petal:
    """A hostile petal. Skimming it without being hit grazes it, once."""
    grazed: bool = field(False)


@component("bloom")
class Bloom:
    kind: ContentRef[BloomDef] = field()
