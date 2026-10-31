"""Demo host for the wifi_router model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wifi_router_demo", title="wifi_router demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
