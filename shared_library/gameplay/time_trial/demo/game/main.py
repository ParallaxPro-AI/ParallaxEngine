"""Demo host for time_trial: a timed canyon and an untimed meadow."""

from parallax import Game
from project import Scenes

from game.lib.time_trial import TrialClock

game = Game(id="time_trial_demo", title="Time trial demo", sdk="1.0", mode="2d",
            systems=[TrialClock], start_scene=Scenes.canyon)
