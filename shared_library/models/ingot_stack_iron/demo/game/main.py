"""Demo host for the ingot_stack_iron model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ingot_stack_iron_demo", title="ingot_stack_iron demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
