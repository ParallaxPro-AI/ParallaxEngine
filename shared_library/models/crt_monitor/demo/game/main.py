"""Demo host for the crt_monitor model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="crt_monitor_demo", title="crt_monitor demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
