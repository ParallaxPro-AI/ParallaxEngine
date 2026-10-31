"""Demo host for the steam_pan model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="steam_pan_demo", title="steam_pan demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
