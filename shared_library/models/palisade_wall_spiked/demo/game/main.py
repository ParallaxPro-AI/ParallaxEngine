"""Demo host for the palisade_wall_spiked model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="palisade_wall_spiked_demo", title="palisade_wall_spiked demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
