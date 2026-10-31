from parallax import Behavior, behavior, param, vec3
from parallax.characters import Character
from project import Content

from game.actions import Controls


@behavior("player_movement", requires=[Character])
class PlayerMovement(Behavior):
    """Walks, sprints and jumps relative to where the camera looks. In water blocks it
    swims (as the template's block movement does): slower, holding jump rises, letting
    go sinks slowly."""

    swim_factor: float = param(0.6, doc="Walking speed multiplier in water.")
    swim_rise: float = param(3.5, unit="m/s")
    sink_speed: float = param(1.5, unit="m/s")
    water_drag: float = param(5, unit="m/s²", doc="How fast you settle to the sink speed.")

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        direction = ctx.camera.main.relative(ctx.input.axis(Controls.move))
        if self.swimming(ctx):
            body.move(direction, speed=body.walk_speed * self.swim_factor)
            v = body.velocity
            rise = self.swim_rise if ctx.input.held(Controls.jump) else max(-self.sink_speed, v.y - self.water_drag * dt)
            body.launch(vec3(v.x, rise, v.z))
            return
        body.move(direction, run=ctx.input.held(Controls.sprint))
        if ctx.input.pressed(Controls.jump):
            body.jump()

    def swimming(self, ctx) -> bool:
        chest = ctx.voxels.cell_at(self.entity.transform.position + vec3(0, 0.8, 0))
        return ctx.voxels.get(chest) == Content.block.water
