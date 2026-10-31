"""Demo host for the modern_media_console model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="modern_media_console_demo", title="modern_media_console demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
