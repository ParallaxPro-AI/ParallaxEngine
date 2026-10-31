"""Demo host for the fan_updraft model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fan_updraft_demo", title="fan_updraft demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
