"""Demo host for the teacher_lectern model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="teacher_lectern_demo", title="teacher_lectern demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
