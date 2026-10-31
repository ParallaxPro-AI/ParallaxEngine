"""Demo host for the andon_stack_light model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="andon_stack_light_demo", title="andon_stack_light demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
