from parallax import Animator, Behavior, behavior, heading_to, param, state
from parallax.combat import Health
from parallax.nav import NavAgent

from features.fighting.feature import Animations, Attacker, Stats, chase, distance, walk_to
from features.heroes.components import Orders


@behavior("hero_motor", requires=[Orders, Attacker, Stats, NavAgent, Health, Animations, Animator])
class HeroMotor(Behavior):
    """Carries out a champion's orders, whoever gave them. It walks to the
    destination, or closes to attack range of the target and holds there for
    basic_attack to swing. Plays the run and idle clips as it goes."""

    arrive_within: float = param(0.5, unit="m")
    running: bool = state(False)

    def update(self, ctx, dt):
        agent = self.entity.get(NavAgent)
        if self.entity.get(Health).dead:
            agent.stop()
            return
        orders = self.entity.get(Orders)
        target = self.entity.get(Attacker).target
        if target and target.alive:
            orders.destination = None
            if distance(self.entity, target) > self.entity.get(Stats).attack_range:
                chase(agent, target)
            else:
                agent.stop()
                tf = self.entity.transform
                tf.euler = tf.euler.with_y(heading_to(tf.position, target.transform.position))
        elif orders.destination:
            walk_to(agent, orders.destination)
            if (self.entity.transform.position - orders.destination).flat().length() < self.arrive_within:
                orders.destination = None
        else:
            agent.stop()
        self._animate(agent.moving)

    def _animate(self, moving: bool):
        if moving == self.running:
            return
        self.running = moving
        clips = self.entity.get(Animations).clips
        self.entity.get(Animator).play(clips.run if moving else clips.idle)
