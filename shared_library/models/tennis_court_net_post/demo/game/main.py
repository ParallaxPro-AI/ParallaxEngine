"""Demo host for the tennis_court_net_post model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tennis_court_net_post_demo", title="tennis_court_net_post demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
