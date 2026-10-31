"""Demo host for the drying_rack_fish model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="drying_rack_fish_demo", title="drying_rack_fish demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
