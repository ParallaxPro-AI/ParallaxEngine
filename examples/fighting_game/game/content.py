"""Content registries: the movelist, the rivals, the lessons and the difficulty levels.

Frame data is authored in fighting-game frames (`unit="frames"`) because that is how
the genre tunes; `rules.frames()` converts with `Rules.frame_rate`.
"""

from enum import Enum

from parallax import ClipRef, ContentRef, Localized, SoundRef, content, field


class Style(Enum):
    """How a rival's brain picks attacks."""
    SPACING = "spacing"
    ARMOUR = "armour"
    ANTIAIR = "antiair"
    ZONING = "zoning"
    BOSS = "boss"


class Goal(Enum):
    """What passes a training lesson."""
    WALK = "walk"
    LAND_JAB = "land_jab"
    GUARD = "guard"
    PUNISH = "punish"
    LAND_SUPER = "land_super"


@content("move")
class MoveDef:
    """One attack: its frame data, what it does on contact and how it looks and sounds."""
    label: Localized
    clip: ClipRef
    swing_sound: SoundRef
    hit_sound: SoundRef = field(doc="Played at the defender on a clean hit.")
    startup: int = field(min=1, unit="frames")
    active: int = field(min=1, unit="frames")
    recovery: int = field(min=0, unit="frames")
    damage: float = field(min=0)
    reach: float = field(unit="m", doc="Forward length of the hitbox.")
    box_height: float = field(unit="m")
    hitstun: int = field(unit="frames")
    blockstun: int = field(unit="frames")
    hitstop: float = field(unit="s")
    knockback: float = field(unit="m/s")
    shake: float = field(0, min=0, doc="Camera shake on a clean hit.")
    rumble: float = field(0, min=0, unit="s", doc="Haptic pulse on a clean hit.")
    meter_cost: float = field(0, min=0)
    throws_bolt: bool = field(False, doc="Spawns a Chi Bolt instead of checking a hitbox.")
    knocks_down: bool = field(False)
    beats_low_guard: bool = field(False, doc="Hits a crouching guard (air attacks).")
    called_out: bool = field(False, doc="Call out the move's name when it starts (supers).")
    cancels_into: list[ContentRef["MoveDef"]] = field([], doc="Moves this one may cancel into during recovery once it has hit.")
    in_air: ContentRef["MoveDef"] | None = field(None, doc="Used instead when started airborne; None means it can't be.")


@content("rival")
class RivalDef:
    """One rung of the ladder: who they are and how their brain plays."""
    name: Localized
    role: Localized
    taunt: Localized
    kit: str = field(doc='The bruiser model\'s "kit" choice this rival wears (crimson, indigo, jade, violet, amber).')
    style: Style
    walk_speed: float = field(unit="m/s")
    spacing: float = field(unit="m", doc="Distance the rival tries to hold when not attacking.")
    block_chance: float = field(min=0, max=1)
    reaction: float = field(unit="s", doc="Delay before the rival acts on an attack it sees.")
    cadence: float = field(unit="s", doc="Pause between the rival's own attacks.")
    armoured_move: ContentRef[MoveDef] | None = field(None, doc="During this move's startup, light hits don't interrupt.")
    armour_absorbs: list[ContentRef[MoveDef]] = field([])


@content("lesson")
class LessonDef:
    """A training step: what the player must do, and what the dummy throws at them."""
    title: Localized
    hint: Localized
    verb: Localized = field(doc="The lesson card's verb beside the key cap (TAP, HOLD, WALK).")
    key: str = field(doc='The key cap: an attack ("light", "guard", "super"; follows remaps) or a literal letter.')
    goal: Goal
    rival_attack: ContentRef[MoveDef] | None = field(None)
    min_meter: float = field(0, doc="The challenger's SPIRIT never drops below this during the lesson.")


@content("difficulty")
class DifficultyDef:
    """How hard the rivals play: scales on their reactions, attack cadence and damage."""
    name: Localized
    reaction_scale: float = field(1, min=0.1)
    cadence_scale: float = field(1, min=0.1)
    damage_scale: float = field(1, min=0.1)
