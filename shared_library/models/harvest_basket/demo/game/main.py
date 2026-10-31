"""Demo host for the harvest_basket model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="harvest_basket_demo", title="harvest_basket demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
