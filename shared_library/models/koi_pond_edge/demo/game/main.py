"""Demo host for the koi_pond_edge model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="koi_pond_edge_demo", title="koi_pond_edge demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
