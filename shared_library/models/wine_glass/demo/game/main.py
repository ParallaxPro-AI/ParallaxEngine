"""Demo host for the wine_glass model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wine_glass_demo", title="wine_glass demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
