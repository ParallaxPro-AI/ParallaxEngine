"""Demo host for the blood_bag_stand model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="blood_bag_stand_demo", title="blood_bag_stand demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
