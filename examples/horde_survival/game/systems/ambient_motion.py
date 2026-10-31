import math

from parallax import Model, System, system

from game.components import AmbientMotion, Motion


@system("ambient_motion")
class AmbientMotionSystem(System):
    """Poses every decor model's ambient joints from the clock, so they stay in step and
    cost nothing to save."""

    def update(self, ctx, dt):
        for _, model, motion in ctx.world.query(Model, AmbientMotion):
            for move in motion.moves:
                cycle = ctx.time.now / move.period + move.phase
                limits = model.limits(move.joint)
                if move.mode is Motion.SPIN or limits is None:
                    model.pose(move.joint, 360 * (cycle % 1))
                    continue
                openness = move.low + (move.high - move.low) * (0.5 - 0.5 * math.cos(2 * math.pi * cycle))
                low, high = limits
                model.pose(move.joint, low + (high - low) * openness)
