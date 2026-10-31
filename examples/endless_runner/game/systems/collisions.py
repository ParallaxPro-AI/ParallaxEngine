"""Judges the runner against everything in the street."""

from parallax import System, system
from project import Scenes

from game.components import Coin, Obstacle, PowerUp, Runner
from game.config import Rules
from game.content import Avoid, PowerUpEffect
from game.events import CoinTaken, NearMissed, ObstacleHit, ObstacleSmashed, PowerUpTaken
from game.resources import Run, buff, live


@system("collisions", scenes=[Scenes.street], when=live)
class Collisions(System):
    """Reports what the runner touched; other systems decide what it's worth.

    Coins and power-ups are collected within `collect_radius`. An obstacle is
    judged by how it must be avoided: a jump row is cleared by feet above its
    clearance, a slide row by sliding, a side-step row only by not being in its
    lane. On the sprint board everything is smashed instead. The contact test is
    swept over the distance run this frame, so speed can't tunnel through a
    barrier. Passing close alongside an obstacle untouched is a near miss."""

    def update(self, ctx, dt):
        runner_entity, runner = ctx.world.query(Runner).single()
        here = runner_entity.transform.position
        reach = ctx.config(Rules).collect_radius

        for coin in ctx.world.query(tagged=Coin).near(here, reach).to_list():
            ctx.emit(CoinTaken(at=coin.transform.position))
            coin.destroy()
        for entity, powerup in ctx.world.query(PowerUp).near(here, reach).to_list():
            ctx.emit(PowerUpTaken(kind=powerup.kind, at=entity.transform.position))
            entity.destroy()
        for entity, obstacle in ctx.world.query(Obstacle).to_list():
            if self.judge(ctx, runner, here, runner.speed * dt, entity, obstacle):
                return  # one hit per frame

    def judge(self, ctx, runner, here, travelled, entity, obstacle) -> bool:
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        kind = obstacle.kind.data
        at = entity.transform.position
        ahead = at.z - here.z
        side = abs(at.x - here.x)
        depth = kind.half_depth + rules.body_depth

        if abs(ahead) <= depth + 1 and side < rules.near_miss_radius:
            obstacle.brushed = True
        if ahead < -travelled - depth:
            if obstacle.brushed:
                obstacle.brushed = False
                ctx.emit(NearMissed(at=at))
            return False
        if ahead > depth or side > kind.half_width + rules.body_width:
            return False

        if buff(ctx, PowerUpEffect.SPRINT):
            ctx.emit(ObstacleSmashed(at=at))
            entity.destroy()
            return False
        if kind.avoid is Avoid.JUMP and here.y > kind.clearance:
            return False
        if kind.avoid is Avoid.SLIDE and runner.sliding:
            return False
        if ctx.time.now < run.hit_cooldown_until:
            return False
        run.hit_cooldown_until = ctx.time.now + rules.hit_cooldown
        obstacle.brushed = False
        entity.destroy()
        ctx.emit(ObstacleHit(kind=obstacle.kind, at=at))
        return True
