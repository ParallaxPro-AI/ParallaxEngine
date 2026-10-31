"""Per-fighter data, the Chi Bolt, the two corners, and collision layers."""

from enum import Enum

from parallax import ContentRef, Entity, component, field, tag
from parallax.physics import Layers as PhysicsLayers, layer

from game.content import MoveDef

Challenger = tag("challenger")
Rival = tag("rival")


class Corner(Enum):
    CHALLENGER = "challenger"
    RIVAL = "rival"


class FighterState(Enum):
    NEUTRAL = "neutral"
    STARTUP = "startup"
    ACTIVE = "active"
    RECOVERY = "recovery"
    HITSTUN = "hitstun"
    BLOCKSTUN = "blockstun"
    KNOCKDOWN = "knockdown"
    LANDING = "landing"
    VICTORY = "victory"
    KO = "ko"


STUNNED = (FighterState.HITSTUN, FighterState.BLOCKSTUN, FighterState.KNOCKDOWN, FighterState.LANDING)


class Layers(PhysicsLayers):
    fighter = layer()
    bolt = layer()
    stage = layer()


@component("fighter")
class Fighter:
    """A fighter's combat state. The HUD, the rival's brain and the exchange all read it."""
    state: FighterState = field(FighterState.NEUTRAL)
    stun_left: float = field(0, min=0, unit="s")
    move: ContentRef[MoveDef] | None = field(None)
    move_time: float = field(0, unit="s")
    move_started_at: float = field(-1, unit="s", doc="Game time the current move began.")
    move_connected: bool = field(False)
    move_hit: bool = field(False, doc="Connected and wasn't guarded (enables cancels).")
    guarding: bool = field(False)
    crouching: bool = field(False)
    facing: int = field(1, choices=[-1, 1])
    meter: float = field(0, min=0)
    hits_in_combo: int = field(0, doc="Clean hits taken since this fighter last recovered.")
    trail: float = field(1, min=0, max=1, doc="The HUD's damage trail: a health fraction that drains after a hit.")


@component("intent")
class Intent:
    """What the fighter's brain (the player's controls or the rival AI) wants right now."""
    walk: float = field(0, min=-1, max=1)
    jump: bool = field(False)
    guard: bool = field(False)
    crouch: bool = field(False)
    attack: ContentRef[MoveDef] | None = field(None)
    attack_expires_at: float = field(0, unit="s", doc="Game time a buffered attack is dropped.")


@component("bolt")
class Bolt:
    owner: Entity = field()
    heading: int = field(choices=[-1, 1])
