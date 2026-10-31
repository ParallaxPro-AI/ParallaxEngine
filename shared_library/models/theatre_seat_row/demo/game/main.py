"""Demo host for the theatre_seat_row model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="theatre_seat_row_demo", title="theatre_seat_row demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
