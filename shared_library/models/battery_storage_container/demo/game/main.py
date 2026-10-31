"""Demo host for the battery_storage_container model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="battery_storage_container_demo", title="battery_storage_container demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
