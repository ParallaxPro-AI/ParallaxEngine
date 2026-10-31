"""Demo host for the luggage_carousel model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="luggage_carousel_demo", title="luggage_carousel demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
