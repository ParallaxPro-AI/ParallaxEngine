from parallax import Behavior, Color, TriggerEntered, behavior, on, param, vec3
from parallax.physics import Rigidbody
from project import Assets, Content

from game.components import Bolt, Fighter
from game.events import StrikeLanded


@behavior("chi_bolt", requires=[Bolt, Rigidbody])
class ChiBolt(Behavior):
    """Flies along the fight line and strikes the first standing opponent it touches.
    It sails over a crouch and fizzles on the stage walls."""

    speed: float = param(8, unit="m/s")
    lifetime: float = param(2, unit="s")
    trail_color: Color = param(Color.hex("#67dce0"))
    trail_width: float = param(0.2, unit="m")
    trail_seconds: float = param(0.26, unit="s", doc="How much of its path the glowing ribbon keeps.")

    def start(self, ctx):
        bolt = self.entity.get(Bolt)
        self.entity.get(Rigidbody).velocity = vec3(bolt.heading * self.speed, 0, 0)
        self.entity.destroy(after=self.lifetime)
        ctx.vfx.trail(self.entity, color=self.trail_color, width=self.trail_width,
                      seconds=self.trail_seconds, glow=True)
        ctx.audio.play(Assets.sfx.bolt_fire, at=self.entity)

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        owner = self.entity.get(Bolt).owner
        other = event.target
        if other == owner or other.has(Bolt):
            return
        if other.has(Fighter):
            if other.get(Fighter).crouching:
                return
            ctx.emit(StrikeLanded(attacker=owner, defender=other, move=Content.move.chi_bolt))
        self.entity.destroy()
