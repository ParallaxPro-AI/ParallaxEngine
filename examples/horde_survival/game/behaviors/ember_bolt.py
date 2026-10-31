from parallax import Behavior, Color, Entity, behavior, param, state
from parallax.combat import Health
from parallax.physics import Rigidbody

from game.components import Bolt, Horde


@behavior("ember_bolt", requires=[Bolt, Rigidbody])
class EmberBolt(Behavior):
    """Flies straight, burning each enemy it passes within its hit radius once, until it
    has pierced as many as it may. Hit-testing is a spatial query, not a collider, so a
    drafted Wide Flare simply widens the radius."""

    lifetime: float = param(1.1, unit="s")
    trail_color: Color = param(Color.hex("#ffb840"))
    trail_width: float = param(0.22, unit="m")
    trail_seconds: float = param(0.28, unit="s")
    burned: list[Entity] = state([])

    def start(self, ctx):
        self.entity.get(Rigidbody).velocity = self.entity.get(Bolt).velocity
        ctx.vfx.trail(self.entity, color=self.trail_color, width=self.trail_width,
                      seconds=self.trail_seconds, glow=True)
        self.entity.destroy(after=self.lifetime)

    def update(self, ctx, dt):
        bolt = self.entity.get(Bolt)
        here = self.entity.transform.position
        # The bolt flies at muzzle height; foes stand on the ground. Hit-test in the ground
        # plane so the radius is the reach a player sees from above.
        for foe, health in ctx.world.query(Health, tagged=Horde).near(here.flat(), bolt.hit_radius):
            if foe in self.burned:
                continue
            self.burned.append(foe)
            health.damage(bolt.damage, source=self.entity, point=here)
            if len(self.burned) > bolt.pierce:
                self.entity.destroy()
                return
