"""Bots: champions without a player, driven through the same orders and events."""

from parallax import Feature

bots = Feature("bots", requires=["heroes", "fighting", "lanes"], doc="Bot champions.")

__all__ = ["bots"]
