"""Jungle: neutral camps that pay gold and, for the big ones, a permanent buff."""

from parallax import Feature

from features.jungle.components import Camp

jungle = Feature("jungle", requires=["fighting", "economy"], doc="Neutral camps.")

__all__ = ["jungle", "Camp"]
