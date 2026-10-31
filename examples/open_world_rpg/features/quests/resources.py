"""Story state that is not a fact or a quest."""

from enum import Enum

from parallax import Entity, Timer, field, resource


class Ending(Enum):
    NONE = "none"
    VICTORY = "victory"
    DEFEAT = "defeat"


@resource("doom")
class Doom:
    """The Shadow Rift's clock: done until the last chapter opens it. Saved, so reloading keeps the clock."""

    clock: Timer = field(Timer.cooldown(0))
    stormed: bool = field(False, doc="The storm over the finale has rolled in.")


@resource("focus", keep="scene")
class Focus:
    """The NPC within reach to talk to, recomputed every frame."""

    npc: Entity | None = field(None)


@resource("outcome")
class Outcome:
    """How the run ended; the end card is open exactly while this is not `NONE`."""

    ending: Ending = field(Ending.NONE)
