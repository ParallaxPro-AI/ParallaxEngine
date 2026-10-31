"""Demo host for the exam_table_clinic model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="exam_table_clinic_demo", title="exam_table_clinic demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
