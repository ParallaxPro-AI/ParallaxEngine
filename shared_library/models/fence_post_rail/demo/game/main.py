"""Demo host for the fence_post_rail model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fence_post_rail_demo", title="fence_post_rail demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
