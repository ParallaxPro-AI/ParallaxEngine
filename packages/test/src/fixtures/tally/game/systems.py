import random

from parallax import System, system

from game.actions import Controls
from game.events import Bumped
from game.resources import Tally


@system("counter")
class Counter(System):
    def update(self, ctx, dt: float):
        tally = ctx.get(Tally)
        if tally.explode:
            raise ValueError("the counter exploded")
        if ctx.input.pressed(Controls.bump):
            tally.value += 1
            tally.roll = random.randint(1, 1000000)
            print("bump", tally.value)
            ctx.emit(Bumped(total=tally.value))
        if ctx.input.held(Controls.bump):
            tally.held_frames += 1
        if ctx.input.released(Controls.bump):
            tally.releases += 1
        lane = ctx.input.pressed_index(Controls.lanes)
        if lane is not None:
            tally.lane = lane
        if ctx.input.pointer.pressed:
            tally.tap_x = ctx.input.pointer.screen.x
            tally.tap_world_x = ctx.input.pointer.world.x
        if ctx.input.text != "":
            tally.typed += ctx.input.text


@system("steering")
class Steering(System):
    def update(self, ctx, dt: float):
        tally = ctx.get(Tally)
        tally.steered += ctx.input.axis(Controls.steer).x * dt
        tally.throttle = ctx.input.value(Controls.throttle)
