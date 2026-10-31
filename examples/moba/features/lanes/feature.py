"""Lanes: minion waves, towers, the core's guard and tower aggression."""

from parallax import Feature

from features.lanes.components import Minion
from features.lanes.modifiers import core_guard
from features.lanes.resources import WaveClock
from features.lanes.systems.champion_aggression import ChampionAggression
from features.lanes.systems.lane_waves import LaneWaves

lanes = Feature(
    "lanes",
    requires=["fighting", "heroes", "economy"],
    systems=[LaneWaves, ChampionAggression],
    doc="Minion waves, towers and the core.",
)

__all__ = ["lanes", "Minion", "WaveClock", "core_guard"]
