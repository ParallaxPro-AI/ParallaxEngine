from parallax import Behavior, Color, WorldBar, behavior, on, param, state

from game.actions import Controls
from game.components import Ball, Meter
from game.content import Sounds
from game.events import PeriodEnded, ShotReleased, Zone
from game.resources import playing


@behavior("shot_meter", requires=[Meter, WorldBar], when=playing)
class ShotMeter(Behavior):
    """Hold shoot with the ball and the needle sweeps up and back down; where you let
    go decides the shot: green, yellow or a brick. The meter is drawn over your head
    as a WorldBar with the two windows as bands; Soft Touch widens the green.

    The buzzer cancels a charge, so a held button can't fire a shot after the period."""

    charge_time: float = param(1.6, unit="s", doc="One full sweep, up and back.")
    yellow: Color = param(Color.hex("#e8c94a"))
    green: Color = param(Color.hex("#4ade6b"))
    rising: bool = state(True)

    def update(self, ctx, dt):
        meter = self.entity.get(Meter)
        _, ball = ctx.world.query(Ball).single()
        if ball.holder != self.entity:
            self.cancel(meter)
        elif not meter.charging:
            if ctx.input.pressed(Controls.shoot):
                meter.charging = True
                meter.needle = 0
                self.rising = True
                ctx.audio.play(ctx.config(Sounds).charge_start, at=self.entity)
        else:
            self.sweep(meter, dt)
            if not ctx.input.held(Controls.shoot):
                meter.charging = False
                ctx.audio.play(ctx.config(Sounds).charge_release, at=self.entity)
                ctx.emit(ShotReleased(shooter=self.entity, zone=self.zone(meter)))
        self.draw(meter)

    @on(PeriodEnded)
    def buzzer(self, ctx, event):
        meter = self.entity.get(Meter)
        self.cancel(meter)
        self.draw(meter)

    def cancel(self, meter: Meter) -> None:
        meter.charging = False
        meter.needle = 0

    def sweep(self, meter: Meter, dt: float) -> None:
        step = dt / (self.charge_time / 2)
        meter.needle = min(1.0, meter.needle + step) if self.rising else max(0.0, meter.needle - step)
        if meter.needle in (0.0, 1.0):
            self.rising = meter.needle == 0.0

    def zone(self, meter: Meter) -> Zone:
        if meter.green_low <= meter.needle <= meter.green_high:
            return Zone.GREEN
        if meter.yellow_low <= meter.needle <= meter.yellow_high:
            return Zone.YELLOW
        return Zone.MISS

    def draw(self, meter: Meter) -> None:
        """The bar shows exactly the meter's state: shown while charging, bands from
        the (perk-modified) windows."""
        bar = self.entity.get(WorldBar)
        bar.shown = meter.charging
        bar.value = meter.needle
        bar.bands = [(meter.yellow_low, meter.yellow_high, self.yellow),
                     (meter.green_low, meter.green_high, self.green)]
