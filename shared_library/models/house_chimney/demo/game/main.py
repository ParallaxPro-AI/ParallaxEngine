"""Demo host for the house_chimney model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="house_chimney_demo", title="house_chimney demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
