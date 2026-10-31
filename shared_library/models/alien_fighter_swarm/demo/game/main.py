"""Demo host for the alien_fighter_swarm model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="alien_fighter_swarm_demo", title="alien_fighter_swarm demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
