"""Demo host for model_variety: a row of gadgets dressed differently."""

from parallax import Game
from project import Scenes

game = Game(id="model_variety_demo", title="Model variety demo", sdk="1.0", mode="3d", start_scene=Scenes.yard)
