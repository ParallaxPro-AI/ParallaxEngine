"""Ghost racer (library piece `ghost_racer`, on top of `time_trial`).

While a trial's clock runs, `ghost_recorder` samples its entity's position and rotation
every 1/`rate` seconds of trial time into `GhostTake` (keep="scene": every attempt starts
empty). When `TrialFinished` reports a new best, `GhostKeeper` keeps that take for the
trial on the device, under the trial's key (with `TrialRun.variant` set, one ghost per
variant: a 2-lap best never ghosts a 3-lap race). A `ghost_playback` entity placed in the scene replays the kept take
against the current attempt's clock, interpolating between samples, and is hidden when
there is nothing to show (no best yet, before the start, after the ghost's finish).

Sampling and playback both run on the trial clock (game time), so pausing, hit-stop and
snapshots keep the ghost in step, and the same inputs record the same ghost."""

from parallax import (
    Behavior, System, Vec3, behavior, config, field, on, param, record, resource, state, system,
)

from game.lib.scene_tags import Playable
from game.lib.time_trial import TrialFinished, TrialRun, trial_key


@record
class GhostSample:
    time: float
    position: Vec3
    euler: Vec3


@record
class GhostRun:
    seconds: float
    rate: float
    samples: list[GhostSample] = field([])


@config("ghost_racer")
class GhostConfig:
    """config/ghost_racer.json."""
    max_seconds: float = field(600, min=1, unit="s", doc="Longest run kept (the device store holds every sample).")


@resource("ghost_take", keep="scene")
class GhostTake:
    rate: float = field(10)
    samples: list[GhostSample] = field([])


@resource("ghost_records", keep="profile")
class GhostRecords:
    best: dict[str, GhostRun] = field({}, doc="Trial key (time_trial's trial_key) → the fastest run's samples.")


def trial_time(ctx) -> float:
    run = ctx.get(TrialRun)
    if run.started_at < 0:
        return -1.0
    return run.finished_in if run.finished_in >= 0 else ctx.time.now - run.started_at


@behavior("ghost_recorder")
class GhostRecorder(Behavior):
    """Samples this entity's path while the trial clock runs."""

    rate: float = param(10, min=1, max=60, unit="Hz")
    next_at: float = state(0.0, doc="Trial time of the next sample.")

    def late_update(self, ctx, dt):
        run = ctx.get(TrialRun)
        t = trial_time(ctx)
        if t < 0 or run.finished_in >= 0 or t + 1e-6 < self.next_at or t > ctx.config(GhostConfig).max_seconds:
            return
        take = ctx.get(GhostTake)
        take.rate = self.rate
        tf = self.entity.transform
        take.samples.append(GhostSample(time=t, position=tf.position, euler=tf.euler))
        self.next_at = max(self.next_at + 1.0 / self.rate, t)


@behavior("ghost_playback")
class GhostPlayback(Behavior):
    """Replays the kept best run of the scene's trial."""

    def late_update(self, ctx, dt):
        key = trial_key(ctx)
        ghost = ctx.get(GhostRecords).best.get(key) if key is not None else None
        t = trial_time(ctx)
        if ghost is None or not ghost.samples or t < 0 or t > ghost.seconds:
            self.entity.visible = False
            return
        samples = ghost.samples
        i = min(len(samples) - 1, int(t * ghost.rate))
        while i > 0 and samples[i].time > t:
            i -= 1
        a = samples[i]
        b = samples[min(i + 1, len(samples) - 1)]
        span = b.time - a.time
        u = (t - a.time) / span if span > 0 else 0.0
        tf = self.entity.transform
        tf.position = a.position.lerp(b.position, min(1.0, max(0.0, u)))
        tf.euler = b.euler if u > 0.5 else a.euler
        self.entity.visible = True


@system("ghost_keeper", scenes=[Playable])
class GhostKeeper(System):
    """Keeps the take of every new best run."""

    @on(TrialFinished, where=lambda e: e.new_best)
    def best_run(self, ctx, e: TrialFinished):
        take = ctx.get(GhostTake)
        if take.samples:
            ctx.get(GhostRecords).best[e.key] = GhostRun(seconds=e.seconds, rate=take.rate, samples=list(take.samples))
