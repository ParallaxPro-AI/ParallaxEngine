"""Demo host for the airport_check_in_kiosk model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="airport_check_in_kiosk_demo", title="airport_check_in_kiosk demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
