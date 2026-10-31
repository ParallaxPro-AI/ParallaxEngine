"""Demo host for the kelp_strand model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="kelp_strand_demo", title="kelp_strand demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
