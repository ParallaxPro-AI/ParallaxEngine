"""Demo host for the butter_churn model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="butter_churn_demo", title="butter_churn demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
