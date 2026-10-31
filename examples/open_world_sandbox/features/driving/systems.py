"""The radio."""

from parallax import System, on, system
from parallax.vehicles import VehicleEntered, VehicleExited

from features.driving.config import DrivingRules
from features.on_foot.feature import Player


@system("radio")
class Radio(System):
    """Getting into a car tunes in the radio; getting out brings the street back. (The driving controls
    switch themselves on with `active_when`.)"""

    @on(VehicleEntered, where=lambda event: event.source.has(Player))
    def tune_in(self, ctx, event: VehicleEntered):
        ctx.audio.music(ctx.config(DrivingRules).radio, fade=0.5)

    @on(VehicleExited, where=lambda event: event.source.has(Player))
    def tune_out(self, ctx, event: VehicleExited):
        ctx.audio.music(ctx.config(DrivingRules).street, fade=1.5)
