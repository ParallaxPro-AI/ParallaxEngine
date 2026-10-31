"""Demo host for the site_toilet_block model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="site_toilet_block_demo", title="site_toilet_block demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
