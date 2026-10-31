"""How the hero moves and recovers."""

from parallax import Behavior, behavior, on, param, state
from parallax.characters import Character
from parallax.combat import Damaged, Health

from features.hero.actions import HeroControls
from features.hero.components import Dodge, Mana
from game.feed import hint
from project import Text


@behavior("hero_movement", requires=[Character, Health, Dodge])
class HeroMovement(Behavior):
    """Camera-relative walking and running, jumping, and a dodge roll that blows pass straight through."""

    dodge_speed: float = param(9, unit="m/s")
    dodge_invulnerable: float = param(0.35, unit="s")
    dodge_cooldown: float = param(0.9, unit="s")

    def update(self, ctx, dt):
        recharge = self.entity.get(Dodge).ready
        recharge.tick(dt)
        body = self.entity.get(Character)
        health = self.entity.get(Health)
        if health.dead:
            body.stop()
            return
        direction = ctx.camera.main.relative(ctx.input.axis(HeroControls.move))
        body.move(direction, run=ctx.input.held(HeroControls.run))
        if ctx.input.pressed(HeroControls.jump):
            body.jump()
        if ctx.input.pressed(HeroControls.dodge) and recharge.done:
            heading = direction if direction.length() > 0.1 else self.entity.transform.forward.flat()
            body.knockback(heading.normalized() * self.dodge_speed)
            health.protect(self.dodge_invulnerable)
            recharge.restart(self.dodge_cooldown)
            hint(ctx, ctx.text(Text.dodge))


@behavior("hero_vitals", requires=[Health, Mana])
class HeroVitals(Behavior):
    """Mana trickles back all the time; health returns once the hero has been out of harm's way a while."""

    mana_regen: float = param(3, unit="/s")
    health_regen: float = param(1, unit="/s")
    regen_delay: float = param(5, unit="s")
    since_hurt: float = state(99.0)

    @on(Damaged)
    def wounded(self, ctx, event: Damaged):
        self.since_hurt = 0.0

    def update(self, ctx, dt):
        health = self.entity.get(Health)
        if health.dead:
            return
        mana = self.entity.get(Mana)
        mana.current = min(mana.max, mana.current + self.mana_regen * dt)
        self.since_hurt += dt
        if self.since_hurt >= self.regen_delay and health.current < health.max:
            health.heal(self.health_regen * dt)
