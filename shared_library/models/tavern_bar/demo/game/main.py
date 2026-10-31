"""Demo host for the tavern_bar model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tavern_bar_demo", title="tavern_bar demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
