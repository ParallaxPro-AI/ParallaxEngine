"""Demo host for the shipping_container model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shipping_container_demo", title="shipping_container demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
