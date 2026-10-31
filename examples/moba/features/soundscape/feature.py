"""Soundscape: the template's synthesized cues played on the game's events (the
cue sheet is game/audio.py and config/audio.json)."""

from parallax import Feature
from project import Scenes

from features.soundscape.systems import MatchMusic, Soundscape

soundscape = Feature(
    "soundscape",
    requires=["heroes", "lanes"],
    systems=[Soundscape, MatchMusic],
    scenes=[Scenes.arena],
    doc="Combat, death, slow and level-up sounds; the adaptive match music.",
)

__all__ = ["soundscape"]
