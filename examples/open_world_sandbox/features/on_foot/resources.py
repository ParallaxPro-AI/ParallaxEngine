"""The player's game-wide state."""

from enum import Enum

from parallax import Entity, EntityRef, Timer, field, resource


class Setback(Enum):
    """The stinger the player is recovering from."""

    NONE = "none"
    WASTED = "wasted"
    BUSTED = "busted"


@resource("wallet")
class Wallet:
    """Cash. One field, one writer per reason: jobs pay, the street pays, fines and shops take."""

    cash: int = field(500, min=0)


@resource("location", keep="scene")
class Location:
    """The interior zone the player is standing in, or None outdoors. Recomputed every frame."""

    interior: Entity | None = field(None)


@resource("recovery")
class Recovery:
    """The WASTED / BUSTED stinger in progress, and where the player gets back up."""

    kind: Setback = field(Setback.NONE)
    countdown: Timer = field(Timer.cooldown(0))
    release: EntityRef | None = field(None)
