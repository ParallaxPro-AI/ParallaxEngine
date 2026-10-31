"""Demo host for the bonsai_pot model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bonsai_pot_demo", title="bonsai_pot demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
