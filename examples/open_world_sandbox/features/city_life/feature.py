"""The crowd: pedestrians who walk the city's sidewalks, scatter at gunfire, can be run down, and pay out
when robbed of life. The city plugin (the scene's `"city"` block) spawns them and the ambient traffic;
this feature adds what hurting them does."""

from parallax import Feature
from project import Scenes

from features.city_life.systems import Panic, Roadkill, StreetCash
from features.city_life.tags import Pedestrian, RunOver

city_life = Feature(
    "city_life",
    requires=["on_foot", "driving"],
    systems=[Panic, Roadkill, StreetCash],
    scenes=[Scenes.sunset_bay],
    doc="Pedestrians and traffic come from the city plugin; this is panic, roadkill and street cash.",
)

__all__ = ["Pedestrian", "RunOver", "city_life"]
