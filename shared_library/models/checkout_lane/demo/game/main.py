"""Demo host for the checkout_lane model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="checkout_lane_demo", title="checkout_lane demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
