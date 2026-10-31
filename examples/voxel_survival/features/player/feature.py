"""Player: first-person movement, and what the crosshair does. Looking around is the
first-person camera rig's job (prefabs/eye_camera.prefab.json)."""

from parallax import Feature
from project import Scenes

from features.player.components import Aim

player = Feature(
    "player",
    requires=["world", "inventory"],
    scenes=[Scenes.greenwood],
    doc="Movement, mining, placing, using and the hotbar keys.",
)

__all__ = ["player", "Aim"]
