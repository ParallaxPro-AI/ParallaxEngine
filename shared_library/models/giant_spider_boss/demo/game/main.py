"""Demo host for the giant_spider_boss model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="giant_spider_boss_demo", title="giant_spider_boss demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
