"""World: what the blocks do. Breaking and placing, doors and growing things. Block
entities (chests, crops, doors) are the voxels plugin's: a block whose entry names a
prefab gets one, carrying `VoxelBlock(cell=...)`. The day and the time of day are
the scene environment's (`ctx.environment.day`)."""

from parallax import Feature
from project import Scenes

from features.world.components import SafeZone
from features.world.events import BreakRequested, Harvested, PlaceRequested
from features.world.placement import blocks_body
from features.world.systems.building import Building

world = Feature(
    "world",
    requires=["inventory"],
    systems=[Building],
    scenes=[Scenes.greenwood],
    doc="Block rules and growth.",
)

__all__ = ["world", "SafeZone", "blocks_body", "BreakRequested", "PlaceRequested", "Harvested"]
