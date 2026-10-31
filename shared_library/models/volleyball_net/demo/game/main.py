"""Demo host for the volleyball_net model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="volleyball_net_demo", title="volleyball_net demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
