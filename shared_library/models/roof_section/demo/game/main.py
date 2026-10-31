"""Demo host for the roof_section model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="roof_section_demo", title="roof_section demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
