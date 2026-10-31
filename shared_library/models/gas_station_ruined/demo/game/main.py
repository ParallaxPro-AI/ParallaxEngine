"""Demo host for the gas_station_ruined model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="gas_station_ruined_demo", title="gas_station_ruined demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
