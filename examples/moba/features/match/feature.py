"""Match: seating players, the draft, starting the match, declaring the winner and
each player's win/loss record."""

from parallax import Feature
from project import Scenes

from features.match.resources import Record
from features.match.systems.draft import Draft
from features.match.systems.lobby import Lobby
from features.match.systems.victory import Victory
from features.match.ui import DraftBoard, GameOverScreen

match = Feature(
    "match",
    requires=["heroes", "economy", "lanes", "vision"],
    systems=[Lobby, Draft, Victory],
    scenes=[Scenes.arena],
    doc="Lobby, draft, start, victory and the record.",
)

__all__ = ["match", "DraftBoard", "GameOverScreen", "Record"]
