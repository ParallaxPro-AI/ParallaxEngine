"""Demo host for the house_railing_balcony model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="house_railing_balcony_demo", title="house_railing_balcony demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
