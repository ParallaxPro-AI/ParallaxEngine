"""Demo host for the packaging_line_station model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="packaging_line_station_demo", title="packaging_line_station demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
