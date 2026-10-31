"""Demo host for the goldfish_scoop_stall model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="goldfish_scoop_stall_demo", title="goldfish_scoop_stall demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
