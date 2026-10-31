"""Ember Circle: survive three minutes of an endless horde. The staff fires itself."""

from parallax import Game
from parallax.plugins import characters, combat, hud, physics3d
from project import Scenes

from game.components import Layers
from game.systems.ambient_motion import AmbientMotionSystem
from game.systems.hit_feedback import HitFeedback
from game.systems.horde_spawner import HordeSpawner
from game.systems.kill_rewards import KillRewards
from game.systems.leveling import Leveling
from game.systems.run_clock import RunClock
from game.systems.run_end import RunEnd
from game.systems.run_setup import RunSetup

game = Game(
    id="horde_survival",
    title="Ember Circle",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[physics3d(layers=Layers), characters(), combat(), hud()],
    systems=[RunSetup, RunClock, HordeSpawner, KillRewards, HitFeedback, Leveling, RunEnd,
             AmbientMotionSystem],
)
