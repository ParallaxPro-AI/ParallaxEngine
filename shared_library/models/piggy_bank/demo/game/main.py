"""Demo host for the piggy_bank model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="piggy_bank_demo", title="piggy_bank demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
