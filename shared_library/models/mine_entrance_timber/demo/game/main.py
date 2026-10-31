"""Demo host for the mine_entrance_timber model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mine_entrance_timber_demo", title="mine_entrance_timber demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
