"""Demo host for the checkpoint_flag model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="checkpoint_flag_demo", title="checkpoint_flag demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
