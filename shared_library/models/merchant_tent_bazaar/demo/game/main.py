"""Demo host for the merchant_tent_bazaar model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="merchant_tent_bazaar_demo", title="merchant_tent_bazaar demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
