"""Demo host for the desk_fan model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="desk_fan_demo", title="desk_fan demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
