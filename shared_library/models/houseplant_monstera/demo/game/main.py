"""Demo host for the houseplant_monstera model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="houseplant_monstera_demo", title="houseplant_monstera demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
