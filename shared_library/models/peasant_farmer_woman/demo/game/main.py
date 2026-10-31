"""Demo host for the peasant_farmer_woman model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="peasant_farmer_woman_demo", title="peasant_farmer_woman demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
