"""Demo host for the easter_egg_basket model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="easter_egg_basket_demo", title="easter_egg_basket demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
