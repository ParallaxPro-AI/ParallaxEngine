from parallax import Animator, Behavior, Entity, behavior, heading_to, param, state, vec3
from parallax.combat import Health

from features.fighting.components import Animations, Attacker, Stats
from features.fighting.targeting import can_fight, distance
from game.components import Physical


@behavior("basic_attack", requires=[Attacker, Stats])
class BasicAttack(Behavior):
    """Swings at the attacker's target whenever it is in range. A short wind-up
    comes first, and the blow lands only if the target is still in reach, so a
    step back at the right moment dodges it. The hit shows the attacker's `bolt` effect."""

    windup_fraction: float = param(0.28, doc="Share of the attack interval spent winding up.")
    max_windup: float = param(0.34, unit="s")
    lands_at: float = state(0.0)

    def update(self, ctx, dt):
        attacker = self.entity.get(Attacker)
        if not can_fight(ctx, self.entity, attacker.target):
            attacker.target = None
            self.lands_at = 0
            return
        stats = self.entity.get(Stats)
        in_reach = distance(self.entity, attacker.target) <= stats.attack_range
        if self.lands_at:
            if ctx.time.now >= self.lands_at:
                self.lands_at = 0
                if in_reach:
                    self._land(ctx, attacker, stats.damage)
            return
        if in_reach and ctx.time.now >= attacker.ready_at:
            attacker.ready_at = ctx.time.now + stats.attack_interval
            self.lands_at = ctx.time.now + min(self.max_windup, stats.attack_interval * self.windup_fraction)
            self._wind_up(attacker.target)

    def _wind_up(self, target: Entity):
        tf = self.entity.transform
        tf.euler = tf.euler.with_y(heading_to(tf.position, target.transform.position))
        animations = self.entity.try_get(Animations)
        if animations and animations.clips.attack:
            self.entity.get(Animator).play_once(animations.clips.attack)

    def _land(self, ctx, attacker: Attacker, damage: float):
        attacker.target.get(Health).damage(damage, source=self.entity, kind=Physical)
        if attacker.bolt:
            ctx.vfx.play(attacker.bolt, at=attacker.target.transform.position + vec3(0, 1, 0))
