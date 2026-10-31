import random

from parallax import System, Vec2, system, vec3
from project import Assets, Scenes

from game.content import EntranceDef
from game.heat import heat
from game.horde import current_surge, spawn_cluster
from game.resources import Run
from game.rules import Rules, alert, play, run_live, scales, survivor


@system("horde_spawner", scenes=[Scenes.arena], when=run_live)
class HordeSpawner(System):
    """The escalation. The current time tier sends a surge every few seconds out of the
    hottest sector of the seed's heat field (and more of it, the hotter it runs); the
    scripted entrances bring in the Ash Wardens with their banners."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        center = survivor(ctx).transform.position
        self.entrances(ctx, run, center)
        if ctx.time.now < run.next_surge_at:
            return
        surge = current_surge(ctx)
        run.next_surge_at = ctx.time.now + surge.interval
        origin, warmth = self.hottest_point(ctx, center)
        vigil = scales(ctx)
        density = (1 + warmth * rules.hot_bonus) * vigil.count
        for enemy, count in surge.groups.items():
            spawn_cluster(ctx, enemy, int(count * density), origin,
                          surge.hp_scale * vigil.hp, surge.speed_scale * vigil.speed)

    def entrances(self, ctx, run, center):
        vigil = scales(ctx)
        for entrance in ctx.content(EntranceDef):
            if entrance.data.at_second > ctx.time.scene_time or entrance in run.entrances_fired:
                continue
            run.entrances_fired.append(entrance)
            data = entrance.data
            origin = self.ring_point(ctx, center, random.uniform(0, 360), ctx.config(Rules).spawn_ring[1])
            spawn_cluster(ctx, data.enemy, data.count, origin, data.hp_scale * vigil.hp, vigil.speed)
            ctx.vfx.play(Assets.vfx.warden_smoke, at=origin + vec3(0, 1, 0))
            alert(ctx, ctx.text(data.alert), ctx.config(Rules).entrance_alert_seconds)
            play(ctx, ctx.config(Rules).sounds.warden)

    def hottest_point(self, ctx, center):
        """Sample the heat field around the spawn ring; the hottest legal point wins."""
        rules = ctx.config(Rules)
        start = random.uniform(0, 360)
        candidates = []
        for i in range(rules.heat_candidates):
            angle = start + 360 * i / rules.heat_candidates
            point = self.ring_point(ctx, center, angle, random.uniform(*rules.spawn_ring))
            candidates.append((heat(point, ctx.seed, rules.heat_frequency, rules.heat_octaves), point))
        warmth, point = max(candidates, key=lambda candidate: candidate[0])
        return point, warmth

    def ring_point(self, ctx, center, angle, distance):
        """`distance` from the survivor and inside the arena: a point past the wall is
        flipped to the other side of the survivor instead of clamped onto them."""
        rules = ctx.config(Rules)
        edge = rules.arena_radius - rules.wall_margin
        for heading in (angle, angle + 180):
            point = center + Vec2.from_angle(heading, distance).to_ground()
            if point.length() <= edge:
                return point
        return center - center.flat().normalized() * rules.spawn_ring[0]
