"""Demo host for the toy_rc_tread model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="toy_rc_tread_demo", title="toy_rc_tread demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
