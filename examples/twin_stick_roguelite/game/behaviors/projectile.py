from parallax import Behavior, TriggerEntered, behavior, on
from parallax.combat import Health
from parallax.physics import Rigidbody

from game.components import Projectile


@behavior("projectile", requires=[Projectile, Rigidbody])
class ProjectileFlight(Behavior):
    """Flies straight and spends itself on the first thing it touches. Collision layers
    decide what that can be: shards hit foes, props and walls; spit hits the keeper and walls."""

    def start(self, ctx):
        projectile = self.entity.get(Projectile)
        self.entity.get(Rigidbody).velocity = projectile.velocity
        self.entity.destroy(after=projectile.lifetime)

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        health = event.target.try_get(Health)
        if health is not None:
            health.damage(self.entity.get(Projectile).damage, source=self.entity,
                          point=self.entity.transform.position)
        self.entity.destroy()
