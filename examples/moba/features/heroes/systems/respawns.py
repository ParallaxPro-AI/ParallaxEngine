from parallax import Animator, System, on, system
from parallax.combat import Died, Health
from parallax.nav import NavAgent

from features.fighting.feature import Animations, Attacker, Stats
from features.heroes.components import Hero, Mana, Orders, Progression
from features.heroes.places import fountain_of
from game.audio import Sounds, play
from game.config import MatchRules


@system("respawns")
class Respawns(System):
    """A fallen champion lies where it fell for a time that grows with its level,
    then stands up at its fountain with full health and mana. The body is kept
    (`Health.revive`), so level, items and ranks carry through death."""

    @on(Died)
    def fell(self, ctx, event: Died):
        hero = event.entity.try_get(Hero)
        if hero is None:
            return
        rules = ctx.config(MatchRules)
        level = event.entity.get(Progression).level
        hero.respawn_at = ctx.time.now + min(rules.respawn_max, rules.respawn_base + rules.respawn_per_level * (level - 1))
        hero.recall_at = 0
        event.entity.get(Orders).destination = None
        event.entity.get(Attacker).target = None
        event.entity.get(Animator).play(event.entity.get(Animations).clips.death, loop=False)

    def update(self, ctx, dt):
        for unit, hero, health in ctx.world.query(Hero, Health):
            if health.dead and ctx.time.now >= hero.respawn_at:
                unit.transform.position = fountain_of(ctx, unit).transform.position
                unit.get(NavAgent).stop()
                health.revive()
                unit.get(Mana).current = unit.get(Stats).max_mana
                unit.get(Animator).play(unit.get(Animations).clips.idle)
                play(ctx, ctx.config(Sounds).respawn, unit)
