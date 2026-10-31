from parallax import Behavior, behavior, heading_to, param, state, vec3
from parallax.combat import Health

from game.components import Foe, Horde
from game.rules import survivor


@behavior("swarm_chase", requires=[Foe], tick="significance")
class SwarmChase(Behavior):
    """Closes on the survivor as one body in a crowd: nudged apart by its nearest
    neighbours, biting on a cadence once in reach. Ranged foes stop at their standoff."""

    standoff: float = param(0, unit="m", doc="Stop this far away (spitters); 0 = close to bite.")
    separation: float = param(1.15, unit="m")
    push: float = param(0.55, doc="How hard neighbours push apart.")
    max_neighbours: int = param(4)
    bite_range: float = param(1.25, unit="m")
    bite_interval: float = param(0.7, unit="s")
    bite_at: float = state(0.0, doc="Game time the next bite may land.")

    def update(self, ctx, dt):
        foe = self.entity.get(Foe)
        target = survivor(ctx)
        here = self.entity.transform.position
        offset = (target.transform.position - here).flat()
        distance = offset.length()
        self.entity.transform.euler = vec3(0, heading_to(here, target.transform.position), 0)

        if distance <= self.bite_range:
            if ctx.time.now >= self.bite_at:
                self.bite_at = ctx.time.now + self.bite_interval
                target.get(Health).damage(foe.damage, source=self.entity)
            return
        if distance <= self.standoff:
            return

        heading = offset / distance
        neighbours = ctx.world.query(tagged=Horde).near(here, self.separation).to_list()
        for other in neighbours[:self.max_neighbours]:
            apart = (here - other.transform.position).flat()
            if other != self.entity and apart.length() > 0:
                heading += apart.normalized() * self.push
        self.entity.transform.position = here + heading.normalized() * foe.speed * dt
