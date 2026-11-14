"""Demo host for the humanoid_gestures clips: a humanoid puppet on a stage."""

from parallax import Game
from project import Scenes

game = Game(id="humanoid_gestures_demo", title="humanoid_gestures demo", sdk="1.0", mode="3d", start_scene=Scenes.stage)
