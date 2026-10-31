"""Demo host for the gatling_gun model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="gatling_gun_demo", title="gatling_gun demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
