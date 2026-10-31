"""Demo host for the old_tv_static model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="old_tv_static_demo", title="old_tv_static demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
