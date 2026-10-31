"""Demo host for the butcher_meat_display model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="butcher_meat_display_demo", title="butcher_meat_display demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
