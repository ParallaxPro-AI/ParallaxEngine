"""Demo host for the space_mine_floating model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="space_mine_floating_demo", title="space_mine_floating demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
