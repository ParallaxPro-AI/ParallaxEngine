"""Vision: fog of war (the net plugin's `visible=` filter) and wards."""

from parallax import Feature

from features.vision.components import Sight, WardKit
from features.vision.systems.warding import Warding
from features.vision.visibility import visible

vision = Feature("vision", requires=["heroes"], systems=[Warding], doc="Fog of war and wards.")

__all__ = ["vision", "Sight", "WardKit", "visible"]
