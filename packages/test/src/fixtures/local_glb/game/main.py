from parallax import Game
from project import Scenes

game = Game(
    id="local_glb",
    title="Local glb",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.main,
)
