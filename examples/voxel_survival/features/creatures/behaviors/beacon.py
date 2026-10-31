from parallax import Behavior, behavior, on
from parallax.voxels import VoxelBlock
from project import Text

from features.creatures.resources import Siege
from features.world.feature import SafeZone
from game.config import Rules
from game.events import Used


@behavior("beacon", requires=[VoxelBlock, SafeZone])
class Beacon(Behavior):
    """Lighting the signal beacon starts the siege: a storm rolls in and hostiles
    pour in, day or night, until the player has held the ground around it long enough."""

    @on(Used)
    def used(self, ctx, event: Used):
        siege = ctx.get(Siege)
        if siege.held:
            ctx.ui.toast(Text.beacon_already_held)
            return
        if siege.seconds_left > 0:
            return
        rules = ctx.config(Rules)
        siege.seconds_left = rules.siege_seconds
        siege.beacon = self.entity.get(VoxelBlock).cell
        ctx.weather.set(rules.siege_weather, seconds=4)
        ctx.ui.announce(Text.siege_title, ctx.text(Text.siege_subtitle, radius=round(rules.siege_radius),
                                                   seconds=round(rules.siege_seconds)))
