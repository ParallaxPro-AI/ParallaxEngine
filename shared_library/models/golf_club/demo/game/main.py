"""Demo host for the golf_club model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="golf_club_demo", title="golf_club demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
