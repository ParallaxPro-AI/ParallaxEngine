"""Demo host for the lobby_fountain_indoor model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="lobby_fountain_indoor_demo", title="lobby_fountain_indoor demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
