from parallax import Game
from parallax.plugins import procgen, voxels
from project import Scenes

game = Game(
    id="worldgen_probe",
    title="Worldgen Probe",
    sdk="1.0",
    mode="3d",
    plugins=[procgen(), voxels()],
    systems=[],
    start_scene=Scenes.world,
)
