"""Demo host for the fern_clump model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fern_clump_demo", title="fern_clump demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
