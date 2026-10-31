"""Demo host for the paint_roller_tray model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="paint_roller_tray_demo", title="paint_roller_tray demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
