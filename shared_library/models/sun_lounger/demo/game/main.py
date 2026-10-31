"""Demo host for the sun_lounger model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="sun_lounger_demo", title="sun_lounger demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
