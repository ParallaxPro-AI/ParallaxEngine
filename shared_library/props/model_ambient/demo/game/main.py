"""Demo host for model_ambient: a gadget whose fan spins, lid bobs and hatch opens for the visitor."""

from parallax import Game, tag
from project import Scenes

Visitor = tag("visitor")

game = Game(id="model_ambient_demo", title="Model ambient demo", sdk="1.0", mode="3d", start_scene=Scenes.yard)
