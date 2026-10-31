"""Ember."""

from parallax import Behavior, Entity, behavior, on, param, state
from parallax.combat import Damaged, Died, Health
from parallax.nav import NavAgent
from project import Text

from parallax.hud import Nameplate

from features.combat.feature import Hostile, Physical, Threat
from features.companion.components import Companion
from features.hero.feature import Hero, HeroRespawned
from game.feed import announce


@behavior("companion_fox", requires=[Companion, Health, NavAgent])
class CompanionFox(Behavior):
    """Keeps close to the hero and bites whatever the hero is fighting.

    Every `taunt_every` seconds of fighting, a bite taunts its victim for `taunt_seconds`: the enemy
    turns on Ember instead, which is how a much weaker fox holds a boss's attention. At zero health
    he is knocked down — no taunts, no bites — and gets back up after `revive_seconds`, or at once
    when the hero rises at a shrine.
    """

    follow_distance: float = param(3.2, unit="m")
    teleport_distance: float = param(34, unit="m", doc="Further than this, he catches up instantly.")
    assist_range: float = param(9, unit="m", doc="Fights within this distance of the hero are his.")
    bite_range: float = param(1.8, unit="m")
    bite_damage: float = param(9)
    bite_cooldown: float = param(1.2, unit="s")
    taunt_every: float = param(6, unit="s")
    taunt_seconds: float = param(3.5, unit="s")
    revive_seconds: float = param(14, unit="s")
    regen_delay: float = param(6, unit="s")
    regen_rate: float = param(4, unit="/s")

    bite_ready_in: float = state(0.0)
    since_taunt: float = state(99.0)
    since_hurt: float = state(99.0)

    @on(Damaged)
    def wounded(self, ctx, event: Damaged):
        self.since_hurt = 0.0

    @on(Died)
    def knocked_down(self, ctx, event: Died):
        self.entity.get(Companion).revive.restart(self.revive_seconds)
        self.entity.get(NavAgent).stop()
        self.entity.transform.euler = self.entity.transform.euler.with_z(90)
        announce(ctx, ctx.text(Text.ember_down, name=ctx.text(self.entity.get(Companion).name), seconds=round(self.revive_seconds)))

    @on(HeroRespawned)
    def hero_rose(self, ctx, event: HeroRespawned):
        if self.entity.get(Health).dead:
            self.entity.transform.position = event.hero.transform.position - event.hero.transform.forward * 2
            self.rise()

    def update(self, ctx, dt):
        self.bite_ready_in = max(0.0, self.bite_ready_in - dt)
        self.since_taunt += dt
        self.since_hurt += dt
        health = self.entity.get(Health)
        if health.dead:
            if self.entity.get(Companion).revive.tick(dt):
                self.rise()
            return
        if self.since_hurt >= self.regen_delay and health.current < health.max:
            health.heal(self.regen_rate * dt)
        hero = ctx.world.query(tagged=Hero).single()
        foe = self.pick_foe(ctx, hero)
        if foe is not None:
            self.fight(ctx, foe)
        else:
            self.follow(hero)

    def pick_foe(self, ctx, hero: Entity) -> Entity | None:
        """The nearest engaged, living hostile within assist range of the hero."""
        row = (
            ctx.world.query(Threat, Health, tagged=Hostile)
            .near(hero.transform.position, self.assist_range)
            .where(lambda foe, threat, health: threat.engaged and not health.dead)
            .nearest(self.entity.transform.position)
        )
        return row[0] if row is not None else None

    def fight(self, ctx, foe: Entity):
        agent = self.entity.get(NavAgent)
        if self.entity.transform.position.distance_to(foe.transform.position) > self.bite_range:
            agent.move_to(foe)
            return
        agent.stop()
        if self.bite_ready_in > 0:
            return
        self.bite_ready_in = self.bite_cooldown
        foe.get(Health).damage(self.bite_damage, source=self.entity, kind=Physical)
        if self.since_taunt >= self.taunt_every:
            self.since_taunt = 0.0
            threat = foe.get(Threat)
            threat.taunter = self.entity
            threat.taunt.restart(self.taunt_seconds)
            announce(ctx, ctx.text(Text.ember_taunts, foe=foe.get(Nameplate).text, name=ctx.text(self.entity.get(Companion).name)))

    def follow(self, hero: Entity):
        agent = self.entity.get(NavAgent)
        distance = self.entity.transform.position.distance_to(hero.transform.position)
        if distance > self.teleport_distance:
            self.entity.transform.position = hero.transform.position - hero.transform.forward * 2
        elif distance > self.follow_distance:
            agent.move_to(hero)
        else:
            agent.stop()

    def rise(self):
        self.entity.get(Health).revive()
        self.entity.get(Companion).revive.restart(0)
        self.entity.transform.euler = self.entity.transform.euler.with_z(0)
        self.since_hurt = 99.0
