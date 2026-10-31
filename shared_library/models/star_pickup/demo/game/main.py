"""Demo host for the star_pickup model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="star_pickup_demo", title="star_pickup demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
