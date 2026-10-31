import random

from parallax import Behavior, behavior, heading_to, param, state, vec3
from parallax.combat import Health
from parallax.nav import NavAgent
from project import Placed

from game.components import Foe, Projectile
from game.content import Attack, EnemyDef, Move, Tactic
from game.events import SummonRequested


@behavior("foe_brain", requires=[Foe, Health, NavAgent])
class FoeBrain(Behavior):
    """Runs the enemy's tactics (content/enemy/*.json). Each frame the first tactic whose
    conditions hold AND whose attack is ready decides how it moves and what it fires,
    so a boss whose volley is cooling down falls through to closing in on you."""

    contact_range: float = param(0.9, unit="m")
    muzzle_height: float = param(0.6, unit="m")
    step: float = param(2, unit="m", doc="How far ahead short moves (retreat, strafe) aim.")
    standoff_slack: float = param(0.5, unit="m")
    strafe_flip: tuple[float, float] = param((1.2, 2.8), unit="s")

    shot_at: float = state(0.0, doc="Game time the next shot or burst is ready.")
    summon_at: float = state(0.0, doc="Game time the next summon is ready.")
    strafe_side: int = state(1)
    strafe_flip_at: float = state(0.0)

    def start(self, ctx):
        enemy = self.entity.get(Foe).kind.data
        now = ctx.time.now
        # Bosses hold their first volley for the reveal; trash staggers so a room never fires in unison.
        self.shot_at = now + (enemy.shot_cooldown if enemy.boss else random.uniform(1, 1 + enemy.shot_cooldown))
        self.summon_at = now + enemy.summon_cooldown

    def update(self, ctx, dt):
        if ctx.cinematics.playing:
            self.hold(dt)
            return
        now = ctx.time.now
        if now >= self.strafe_flip_at:
            self.strafe_flip_at = now + random.uniform(*self.strafe_flip)
            self.strafe_side = -self.strafe_side

        foe = self.entity.get(Foe)
        enemy = foe.kind.data
        keeper = ctx.world.placed(Placed.keeper)
        here = self.entity.transform.position
        to_keeper = (keeper.transform.position - here).flat()
        distance = to_keeper.length()
        self.entity.transform.euler = vec3(0, heading_to(here, keeper.transform.position), 0)
        if distance < self.contact_range:
            keeper.get(Health).damage(foe.contact_damage, source=self.entity)

        tactic = self.choose(enemy, distance, now)
        self.move(tactic.move, enemy, keeper, to_keeper, distance)
        self.attack(ctx, tactic.attack, enemy, to_keeper)

    def hold(self, dt):
        """The boss intro freezes the fight: stand still, and let no cooldown run out."""
        self.entity.get(NavAgent).stop()
        self.shot_at += dt
        self.summon_at += dt

    def choose(self, enemy: EnemyDef, distance: float, now: float) -> Tactic:
        wounded = self.entity.get(Health).fraction < enemy.enrage_below
        for tactic in enemy.tactics:
            if tactic.within and distance > tactic.within:
                continue
            if tactic.wounded and not wounded:
                continue
            if self.ready(tactic.attack, enemy, now):
                return tactic
        return enemy.tactics[-1]

    def ready(self, attack: Attack, enemy: EnemyDef, now: float) -> bool:
        if attack in (Attack.SHOT, Attack.BURST):
            return enemy.shot is not None and now >= self.shot_at
        if attack is Attack.SUMMON:
            return enemy.summon is not None and now >= self.summon_at
        return True

    def move(self, kind: Move, enemy, keeper, to_keeper, distance):
        agent = self.entity.get(NavAgent)
        agent.speed = enemy.move_speed * (enemy.lunge_speed if kind is Move.LUNGE else 1)
        here = self.entity.transform.position
        away = -to_keeper.normalized()
        if kind in (Move.CHASE, Move.LUNGE):
            agent.move_to(keeper)
        elif kind is Move.STANDOFF and distance > enemy.standoff + self.standoff_slack:
            agent.move_to(keeper)
        elif kind is Move.STANDOFF and distance < enemy.standoff - self.standoff_slack:
            agent.move_to(here + away * self.step)
        elif kind is Move.RETREAT:
            agent.move_to(here + away * self.step)
        elif kind is Move.STRAFE:
            agent.move_to(here + away.rotated_y(90 * self.strafe_side) * self.step)
        else:
            agent.stop()

    def attack(self, ctx, kind: Attack, enemy, to_keeper):
        if kind is Attack.SUMMON:
            self.summon_at = ctx.time.now + enemy.summon_cooldown
            ctx.emit(SummonRequested(master=self.entity, count=enemy.summon_count))
        elif kind in (Attack.SHOT, Attack.BURST):
            self.shot_at = ctx.time.now + enemy.shot_cooldown
            count, spread = (enemy.burst_count, enemy.burst_spread) if kind is Attack.BURST else (1, 0)
            aim = to_keeper.normalized()
            for i in range(count):
                angle = 0 if count == 1 else (i / (count - 1) - 0.5) * spread
                self.fire(ctx, enemy, aim.rotated_y(angle))

    def fire(self, ctx, enemy, direction):
        shot = enemy.shot.data
        ctx.world.spawn(
            shot.prefab,
            at=self.entity.transform.position + vec3(0, self.muzzle_height, 0),
            components=[Projectile(velocity=direction * shot.speed, damage=shot.damage, lifetime=shot.lifetime)],
        )
