"""Demo host for the tower_crane_section model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tower_crane_section_demo", title="tower_crane_section demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
