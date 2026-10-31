"""Demo host for the humanoid_boardsports clips: a humanoid puppet on a stage."""

from parallax import Game
from project import Scenes

game = Game(id="humanoid_boardsports_demo", title="humanoid_boardsports demo", sdk="1.0", mode="3d", start_scene=Scenes.stage)
