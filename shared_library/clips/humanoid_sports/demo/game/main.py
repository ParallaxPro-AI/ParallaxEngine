"""Demo host for the humanoid_sports clips: a humanoid puppet on a stage."""

from parallax import Game
from project import Scenes

game = Game(id="humanoid_sports_demo", title="humanoid_sports demo", sdk="1.0", mode="3d", start_scene=Scenes.stage)
