"""Creatures: night hostiles in waves, the beacon siege and grazing wildlife."""

from parallax import Feature
from project import Scenes

from features.creatures.events import BeaconHeld, WaveStarted
from features.creatures.resources import Siege, Waves
from features.creatures.systems.death_loot import DeathLoot
from features.creatures.systems.mob_waves import MobWaves
from features.creatures.systems.siege import SiegeClock
from features.creatures.systems.wildlife import Herds

creatures = Feature(
    "creatures",
    requires=["world", "inventory"],
    systems=[SiegeClock, MobWaves, Herds, DeathLoot],
    scenes=[Scenes.greenwood],
    doc="Hostile waves, the siege, wildlife and creature loot.",
)

__all__ = ["creatures", "Siege", "Waves", "BeaconHeld", "WaveStarted"]
