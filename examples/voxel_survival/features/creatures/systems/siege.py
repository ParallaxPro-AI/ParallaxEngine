from parallax import System, system
from project import Text

from features.creatures.events import BeaconHeld
from features.creatures.resources import Siege
from features.world.feature import SafeZone
from game.config import Rules
from game.world import the_player


@system("siege", when=lambda ctx: ctx.get(Siege).seconds_left > 0)
class SiegeClock(System):
    """Runs the beacon siege's clock, which only ticks while the player stays near
    the beacon. When it runs out the beacon has held, and from then on it keeps
    hostiles away from a wide circle around it. Mining the beacon ends the siege."""

    def update(self, ctx, dt):
        siege = ctx.get(Siege)
        rules = ctx.config(Rules)
        beacon = ctx.voxels.block_entity(siege.beacon)
        if beacon is None:
            siege.seconds_left = 0
            return
        gap = (the_player(ctx).transform.position - beacon.transform.position).flat().length()
        if gap > rules.siege_radius:
            return
        siege.seconds_left = max(0.0, siege.seconds_left - dt)
        if siege.seconds_left == 0:
            siege.held = True
            beacon.get(SafeZone).radius = rules.beacon_safe_radius
            ctx.ui.announce(Text.beacon_held_title, Text.beacon_held_subtitle)
            ctx.emit(BeaconHeld())
