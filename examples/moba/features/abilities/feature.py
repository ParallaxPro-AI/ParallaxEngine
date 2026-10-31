"""Abilities: the data-driven cast pipeline. A champion's kit is four content
entries; this feature checks, pays for and applies them."""

from parallax import Feature

from features.abilities.rpcs import rank_up

abilities = Feature("abilities", requires=["heroes", "fighting"], doc="Casting, effects and ranks.")

__all__ = ["abilities", "rank_up"]
