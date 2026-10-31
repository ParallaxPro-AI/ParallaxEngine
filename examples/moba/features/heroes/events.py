"""Orders a champion takes from whoever drives it: its player's keys, a bot, or an RPC."""

from parallax import Entity, Vec3, event


@event("cast_requested", target="hero")
class CastRequested:
    """`hero` should cast the ability in `slot` (0..3) at `aim`."""
    hero: Entity
    slot: int
    aim: Vec3


@event("rank_up_requested", target="hero")
class RankUpRequested:
    hero: Entity
    slot: int


@event("recall_requested", target="hero")
class RecallRequested:
    hero: Entity


@event("ward_requested", target="hero")
class WardRequested:
    hero: Entity
    at: Vec3
    kind: str
    """"picket", "watchfire" or "hushbell"."""


@event("leveled_up", target="hero")
class LeveledUp:
    hero: Entity
    level: int
