from parallax import System, system
from parallax.combat import Health
from project import Scenes

from game.build import body_reach, find_wisp
from game.components import Guardian, Petal, Spark, Wisp
from game.config import Arena
from game.events import Grazed


@system("collisions", scenes=[Scenes.garden])
class Collisions(System):
    """Every contact in the field: sparks against guardians, and petals and guardian
    bodies against the Wisp's pinpoint hitbox. A petal that passes close without
    hitting is grazed, once. Hits on the Wisp go through its `Health`, whose
    i-frames and dewshields decide what they cost."""

    def update(self, ctx, dt):
        wisp = find_wisp(ctx)
        self.sparks_strike(ctx, wisp.get(Wisp).spark_damage)
        self.hazards_reach(ctx, wisp, wisp.get(Health))

    def sparks_strike(self, ctx, damage: float):
        radius = ctx.config(Arena).spark_radius
        spent = set()
        for target, guardian, health in ctx.world.query(Guardian, Health):
            if health.dead:
                continue
            reach = body_reach(ctx, radius, guardian.kind.data)
            for spark_entity, spark in ctx.world.query(Spark).near(target.transform.position, reach):
                if spark_entity in spent or target in spark.struck:
                    continue
                health.damage(damage, source=spark_entity)
                if spark.pierce:
                    spark.struck.append(target)
                else:
                    spent.add(spark_entity)
                    spark_entity.destroy()

    def hazards_reach(self, ctx, wisp, health):
        arena = ctx.config(Arena)
        here = wisp.transform.position.xy()  # z is draw order: petals sit at 0.5, the Wisp at 0
        open_to_hits = not health.invulnerable
        for petal_entity, petal in ctx.world.query(Petal).near(here, arena.graze_radius):
            if open_to_hits and petal_entity.transform.position.xy().distance_to(here) <= arena.hit_radius:
                petal_entity.destroy()
                health.damage(1, source=petal_entity)
                open_to_hits = False
            elif not petal.grazed:
                petal.grazed = True
                ctx.emit(Grazed(wisp=wisp))
        if not open_to_hits:
            return
        for body, guardian, guardian_health in ctx.world.query(Guardian, Health):
            kind = guardian.kind.data
            if guardian_health.dead or body.transform.position.xy().distance_to(here) > body_reach(ctx, arena.touch_radius, kind):
                continue
            if kind.boss:
                guardian_health.damage(1, source=wisp)
            else:
                guardian_health.kill(source=wisp)
            health.damage(1, source=body)
            return
