"""Ember, the hero's fox: follows, bites what the hero is fighting, draws aggro, and can be knocked down."""

from parallax import Feature

from features.companion.components import Companion

companion = Feature(
    "companion",
    requires=["hero", "combat"],
    doc="Ember the fox. One behavior on one prefab; enemies see him through the combat Threat component.",
)

__all__ = ["Companion", "companion"]
