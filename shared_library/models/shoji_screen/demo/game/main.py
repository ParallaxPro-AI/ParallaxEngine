"""Demo host for the shoji_screen model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shoji_screen_demo", title="shoji_screen demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
