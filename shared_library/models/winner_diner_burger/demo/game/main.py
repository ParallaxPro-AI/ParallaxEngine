"""Demo host for the winner_diner_burger model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="winner_diner_burger_demo", title="winner_diner_burger demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
