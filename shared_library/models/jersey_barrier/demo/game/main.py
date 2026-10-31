"""Demo host for the jersey_barrier model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="jersey_barrier_demo", title="jersey_barrier demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
