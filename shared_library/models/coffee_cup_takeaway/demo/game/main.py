"""Demo host for the coffee_cup_takeaway model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="coffee_cup_takeaway_demo", title="coffee_cup_takeaway demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
