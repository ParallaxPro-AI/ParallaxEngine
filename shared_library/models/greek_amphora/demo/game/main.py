"""Demo host for the greek_amphora model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="greek_amphora_demo", title="greek_amphora demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
