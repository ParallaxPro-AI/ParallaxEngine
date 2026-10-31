"""Demo host for the inn_tavern_exterior model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="inn_tavern_exterior_demo", title="inn_tavern_exterior demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
