"""Curbside Getaway: a three-lane escape through four city districts, a guard on your heels."""

from parallax import Game
from project import Scenes

from game.systems.chase import Chase
from game.systems.collisions import Collisions
from game.systems.escape import Escape
from game.systems.lockup import LockUp
from game.systems.powerups import PowerUps
from game.systems.score import Score
from game.systems.streamer import StreetStreamer

game = Game(
    id="endless_runner",
    title="Curbside Getaway",
    sdk="1.0",
    mode="3d",
    # No physics plugin: the runner flies its own jump, and contact is judged
    # per obstacle by how it must be avoided (side-step, jump or slide).
    plugins=[],
    systems=[Escape, StreetStreamer, Collisions, Score, PowerUps, Chase, LockUp],
    start_scene=Scenes.title,
)
