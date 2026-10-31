"""Demo host for the coral_brain model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="coral_brain_demo", title="coral_brain demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
