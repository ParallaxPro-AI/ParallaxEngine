"""Demo host for the hand_truck model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hand_truck_demo", title="hand_truck demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
