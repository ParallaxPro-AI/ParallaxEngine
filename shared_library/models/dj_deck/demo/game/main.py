"""Demo host for the dj_deck model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dj_deck_demo", title="dj_deck demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
