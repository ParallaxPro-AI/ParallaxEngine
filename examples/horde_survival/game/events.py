"""Typed messages between the arena's systems and behaviors."""

from parallax import event


@event("xp_gained")
class XpGained:
    amount: float


@event("run_ended")
class RunEnded:
    survived: bool
