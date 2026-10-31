from parallax import Animator, Behavior, behavior, param
from parallax.characters import Character
from parallax.vehicles import Vehicle

from project import Assets

from game.actions import Controls, WalkControls
from game.config import FreightRules
from game.rules import plane_in_reach


@behavior("pilot", requires=[Character, Animator])
class PilotBehavior(Behavior):
    """Walks (and jumps) the pilot round the airfields and climbs in and out of the planes — the
    nearest one in reach, whichever island it is parked on.

    Stepping out works only on the ground and nearly stopped, so nobody abandons a plane
    in the air. In the cockpit he is hidden (model and shadow): the plane is solid and he
    would otherwise poke through its fuselage."""

    walk_threshold: float = param(0.4, unit="m/s", doc="Faster than this plays the walk.")

    def update(self, ctx, dt):
        character = self.entity.get(Character)
        seat = character.vehicle
        self.entity.visible = seat is None
        if seat is None:
            character.move(ctx.camera.main.relative(ctx.input.axis(WalkControls.move)))
            walking = character.velocity.flat().length() > self.walk_threshold
            self.entity.get(Animator).play(Assets.clips.walk_cycle if walking else Assets.clips.stand_idle)
            if ctx.input.pressed(WalkControls.jump):
                character.jump()
            nearest = plane_in_reach(ctx)
            if nearest is not None and ctx.input.pressed(Controls.interact):
                nearest.get(Vehicle).enter(self.entity)
        elif ctx.input.pressed(Controls.interact):
            vehicle = seat.get(Vehicle)
            if vehicle.grounded and abs(vehicle.speed) < ctx.config(FreightRules).exit_speed:
                vehicle.exit(self.entity)
