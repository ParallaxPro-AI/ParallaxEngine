"""Content registries: guardians, the waves of the campaign, bloom drops and shrine
attunements. Names are written inline in each entry's JSON; enum fields are written
by value ("spread")."""

from enum import Enum

from parallax import Color, ContentRef, Localized, content, field


class Stat(Enum):
    """A build stat a shrine attunement raises. Each value names a modifiable field
    of the `Wisp` component, except `max_lives`, which is the Wisp's `Health.max`
    (see `game.build.attune`)."""
    FIRE_GAP = "fire_gap"
    SPARK_DAMAGE = "spark_damage"
    SPARK_SPEED = "spark_speed"
    TWIN = "twin"
    MAX_LIVES = "max_lives"
    MOVE_SPEED = "move_speed"
    WAVE_SHIELDS = "wave_shields"
    PICKUP_RADIUS = "pickup_radius"
    DROP_BONUS = "drop_bonus"
    GRAZE_GAIN = "graze_gain"
    MAX_BOMBS = "max_bombs"
    INVULNERABILITY = "invulnerability"


class Gun(Enum):
    SINGLE = "single"
    SPREAD = "spread"
    RAPID = "rapid"
    PIERCE = "pierce"


class Fire(Enum):
    """A guardian's scripted petal pattern (see `game.patterns.volley`)."""
    NONE = "none"
    AIMED = "aimed"
    FAN = "fan"
    RING = "ring"
    SPIRAL = "spiral"
    STORM = "storm"


class Flight(Enum):
    """How a wave flies (see `GuardianFlight.fly`)."""
    SWAY = "sway"
    PLUNGE = "plunge"
    VEE = "vee"
    ROOT = "root"
    SOVEREIGN = "sovereign"


class BloomEffect(Enum):
    GUN = "gun"
    SHIELD = "shield"
    BOMBS = "bombs"


@content("guardian")
class GuardianDef:
    """What a guardian is. A wave says how many fly and how; this says what they are."""
    name: Localized = field()
    hp: float = field(min=1, doc="Sparks to banish it at 1 damage each.")
    scale: float = field(1.0, unit="m")
    score: int = field(min=0)
    fire: Fire = field(Fire.NONE)
    arms: int = field(1, min=1, doc="Petals per volley for fan, ring, spiral and storm.")
    spread: float = field(0, unit="deg", doc="Arc of a fan.")
    spin_step: float = field(0, unit="deg", doc="How far a ring turns between volleys (a spiral).")
    petal_speed: float = field(6.5, unit="m/s")
    boss: bool = field(False, doc="Shown on the boss bar.")
    animation: str = field(doc="Clip name in prefabs/guardian.prefab.json.")


@content("wave", order="number")
class WaveDef:
    """One wave: `count` guardians of one kind flying one flight pattern. The last
    wave is the boss."""
    number: int = field(min=1)
    name: Localized = field()
    act: int = field(1, min=1)
    guardian: ContentRef[GuardianDef] = field()
    flight: Flight = field(Flight.SWAY)
    count: int = field(min=1, max=16)
    speed: float = field(unit="m/s", doc="Downward drift.")
    amp: float = field(unit="m", doc="Width of the sideways sweep.")
    freq: float = field(doc="Sweeps per two seconds.")
    fire_rate: float = field(0, unit="s", doc="Average seconds between volleys; 0 holds fire.")
    hp_mul: float = field(1.0, min=0.1)
    drop_chance: float = field(0, min=0, max=1)


@content("bloom")
class BloomDef:
    """A drop a banished guardian may leave behind."""
    label: Localized = field()
    effect: BloomEffect = field()
    gun: Gun = field(Gun.SINGLE, doc="For `gun`: the gun to fly.")
    duration: float = field(0, unit="s", doc="For `gun`.")
    amount: int = field(1, doc="For `bombs`.")
    weight: float = field(1, min=0, doc="Relative drop odds.")
    color: Color = field()


@content("upgrade")
class UpgradeDef:
    """A shrine attunement: permanent for the rest of the run, up to `max_stacks`.
    Every stack adds `add` to its stat, then multiplies it by `mul`."""
    name: Localized = field()
    description: Localized = field()
    stat: Stat = field()
    add: float = field(0)
    mul: float = field(1)
    max_stacks: int = field(1, min=1)
    heal: int = field(0, doc="Petals mended the moment it is taken.")
    grant_shields: int = field(0)
    grant_bombs: int = field(0)
