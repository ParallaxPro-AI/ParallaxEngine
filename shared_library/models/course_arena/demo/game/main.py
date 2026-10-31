"""Demo host for the course_arena model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="course_arena_demo", title="course_arena demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
