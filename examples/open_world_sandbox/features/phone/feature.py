"""Sam's phone: contacts, a map of named places with a GPS pin, photo mode and the gallery.

A leaf feature. The camera rig reads `PhotoMode`; other features' controls step aside while it is on.
"""

from parallax import Feature
from project import Scenes

from features.phone.content import ContactDef, PlaceDef
from features.phone.resources import PhotoMode, Waypoint
from features.phone.systems import Photography, Waypoints

phone = Feature(
    "phone",
    systems=[Photography, Waypoints],
    scenes=[Scenes.sunset_bay],
    doc="Phone panel (contacts, map, photos), photo mode, and the GPS pin for a routed place.",
)

__all__ = ["ContactDef", "PhotoMode", "PlaceDef", "Waypoint", "phone"]
