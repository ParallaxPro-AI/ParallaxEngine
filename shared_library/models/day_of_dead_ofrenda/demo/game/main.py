"""Demo host for the day_of_dead_ofrenda model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="day_of_dead_ofrenda_demo", title="day_of_dead_ofrenda demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
