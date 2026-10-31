"""Feeds hazards in at the right edge on a rhythm that is always clearable."""

import random

from parallax import System, system, vec2
from project import Content, Prefabs, Scenes

from game.components import Hopper, Obstacle
from game.config import Canyon
from game.content import GapRhythmDef, Lane
from game.events import HazardPlaced
from game.resources import Feed, Run, running


def airtime(hopper: Hopper) -> float:
    """Exactly how long one full hop keeps the runner off the ground."""
    return 2 * hopper.hop_speed / hopper.gravity


@system("hazard_feed", scenes=[Scenes.canyon], when=running)
class HazardFeed(System):
    """Spawns the next hazard once the world has scrolled the rolled gap.

    Gaps are rolled in SECONDS of travel and converted at the current speed,
    because the runner can't hop again until it lands: a gap measured in metres
    would cram hazards together as the world speeds up. Every gap is floored at
    one hop's airtime plus a reaction window, so no stage can produce a wall.
    Air hazards always arrive after a breather, with room to read them.

    In a Journey the feed stops short of the goal for a clean run-in, and the
    finish gate scrolls in so the runner meets it at exactly the goal distance."""

    def start(self, ctx):
        """Start the run with the first hazards already on their way in."""
        cfg = ctx.config(Canyon)
        lead = 0.0
        for index in range(cfg.seed_hazards):
            self.place(ctx, cfg.spawn_x + lead, self.pick(ctx, Lane.GROUND), gap=0, lead_in=index == 0)
            lead += self.roll_gap(ctx)
        feed = ctx.get(Feed)
        feed.since_spawn = -lead  # reaches zero exactly as the last seed crosses the spawn line
        feed.next_gap, feed.next_kind = self.roll_next(ctx)

    def update(self, ctx, dt):
        cfg = ctx.config(Canyon)
        run = ctx.get(Run)
        if not run.endless:
            self.place_gate(ctx, run)
            if run.distance + cfg.spawn_x - cfg.runner_x >= cfg.goal_distance - cfg.run_in:
                return
        feed = ctx.get(Feed)
        feed.since_spawn += run.speed * dt
        if feed.since_spawn < feed.next_gap:
            return
        self.place(ctx, cfg.spawn_x, feed.next_kind, feed.next_gap)
        feed.since_spawn = 0.0
        feed.next_gap, feed.next_kind = self.roll_next(ctx)

    def roll_next(self, ctx):
        if random.random() < ctx.get(Run).stage.data.air_chance:
            return self.roll_gap(ctx, Content.gap_rhythm.breather.data), self.pick(ctx, Lane.AIR)
        return self.roll_gap(ctx), self.pick(ctx, Lane.GROUND)

    def roll_gap(self, ctx, rhythm: GapRhythmDef | None = None) -> float:
        cfg = ctx.config(Canyon)
        run = ctx.get(Run)
        if rhythm is None:
            rhythms = ctx.content(GapRhythmDef)
            rhythm = random.choices(rhythms, weights=[r.data.weight for r in rhythms])[0].data
        _, hopper = ctx.world.query(Hopper).single()
        seconds = random.uniform(rhythm.min_seconds, rhythm.max_seconds) * run.stage.data.gap_scale
        seconds = max(seconds, airtime(hopper) + cfg.min_react_time)
        return max(cfg.floor_distance, seconds * run.speed)

    def pick(self, ctx, lane: Lane):
        """A weighted pick from the current stage's hazards in one lane. A hazard
        the stage doesn't weight can't appear in it: that is how the canyon
        teaches the hop before it ever asks for a duck."""
        weights = {kind: w for kind, w in ctx.get(Run).stage.data.weights.items() if kind.data.lane is lane}
        return random.choices(list(weights), weights=list(weights.values()))[0]

    def place(self, ctx, x, kind, gap, lead_in=False):
        hazard = kind.data
        height = random.uniform(hazard.height_min, hazard.height_max)
        y = ctx.config(Canyon).ground_y + height / 2 if hazard.lane is Lane.GROUND else hazard.air_y
        ctx.world.spawn(hazard.prefab, at=vec2(x, y), scale=height, components=[Obstacle(kind=kind)])
        ctx.emit(HazardPlaced(kind=kind, x=x, gap=gap, lead_in=lead_in))

    def place_gate(self, ctx, run: Run):
        cfg = ctx.config(Canyon)
        feed = ctx.get(Feed)
        remaining = cfg.goal_distance - run.distance
        if feed.gate_placed or remaining > cfg.gate_lead:
            return
        feed.gate_placed = True
        ctx.world.spawn(Prefabs.finish_gate, at=vec2(cfg.runner_x + remaining, cfg.gate_y))
