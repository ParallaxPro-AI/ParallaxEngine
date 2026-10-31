"""Demo host for the seashell_starfish_set model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="seashell_starfish_set_demo", title="seashell_starfish_set demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
