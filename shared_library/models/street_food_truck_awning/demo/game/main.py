"""Demo host for the street_food_truck_awning model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="street_food_truck_awning_demo", title="street_food_truck_awning demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
