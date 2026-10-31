"""Demo host for the fp_arms piece: a first-person camera whose Viewmodel holds a pistol."""

from parallax import Game
from parallax.plugins import viewmodel
from project import Scenes

game = Game(id="fp_arms_demo", title="fp_arms demo", sdk="1.0", mode="3d",
            plugins=[viewmodel()], start_scene=Scenes.range)
