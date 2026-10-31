"""Demo host for the adobe_house model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="adobe_house_demo", title="adobe_house demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
