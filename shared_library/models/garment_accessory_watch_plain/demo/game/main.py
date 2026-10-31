"""Demo host for the garment_accessory_watch_plain model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="garment_accessory_watch_plain_demo", title="garment_accessory_watch_plain demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
