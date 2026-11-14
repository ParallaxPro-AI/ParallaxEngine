"""Demo host for babble: two speakers on a stage."""

from parallax import Game
from project import Scenes

from game.lib.babble import Babble

game = Game(id="babble_demo", title="Babble demo", sdk="1.0", mode="3d", systems=[Babble], start_scene=Scenes.stage)
