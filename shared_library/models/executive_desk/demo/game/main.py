"""Demo host for the executive_desk model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="executive_desk_demo", title="executive_desk demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
