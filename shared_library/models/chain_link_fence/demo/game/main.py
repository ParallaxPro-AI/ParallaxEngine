"""Demo host for the chain_link_fence model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chain_link_fence_demo", title="chain_link_fence demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
