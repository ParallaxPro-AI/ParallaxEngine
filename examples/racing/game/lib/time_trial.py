"""Time trials (library piece `time_trial`).

A scene is timed when some `content/trial/*.json` entry names it. The clock is game time
(`ctx.time.now`), so pausing stops it and a snapshot restores it. The game reports two
moments: `TrialStarted()` (or nothing, with `auto_start`: the clock starts on scene load)
and `FinishReached()`. The piece answers with `TrialFinished(seconds, medal, best,
new_best)` and keeps the device's best time and medal per trial (keep="profile").

One scene can hold several trials: set `TrialRun.variant` (e.g. the lap count) before the
line, and records key on `"<trial id>:<variant>"` (`trial_key`), so a 2-lap best never
stands for a 3-lap race. `"show_timer": false` hides the piece's panel for a game that
draws its own clock."""

from enum import Enum

from parallax import (
    ContentRef, Panel, SceneRef, System, config, content, event, field, on, resource, system, ui,
)

from game.lib.scene_tags import Playable


class Medal(Enum):
    NONE = "none"
    BRONZE = "bronze"
    SILVER = "silver"
    GOLD = "gold"


MEDAL_RANK = {Medal.NONE: 0, Medal.BRONZE: 1, Medal.SILVER: 2, Medal.GOLD: 3}


@content("trial")
class TrialDef:
    """content/trial/<id>.json — a timed scene and its medal times (seconds, at most)."""
    scene: SceneRef
    gold: float = field(min=0, unit="s")
    silver: float = field(min=0, unit="s")
    bronze: float = field(min=0, unit="s")


@config("time_trial")
class TimeTrialConfig:
    """config/time_trial.json."""
    auto_start: bool = field(True, doc="Start the clock when the scene loads; False: on TrialStarted.")
    show_timer: bool = field(True, doc="Show the timer panel; False: the game draws its own clock.")


@resource("trial_run", keep="scene")
class TrialRun:
    started_at: float = field(-1, doc="Game time the clock started; -1: not started.")
    finished_in: float = field(-1, doc="Seconds at the line; -1: still running.")
    variant: str = field("", doc="Optional; records key on '<trial id>:<variant>' when set (e.g. a lap count).")


@resource("trial_records", keep="profile")
class TrialRecords:
    best: dict[str, float] = field({}, doc="Trial key (trial_key) → best seconds.")
    medals: dict[str, Medal] = field({}, doc="Trial key (trial_key) → best medal.")


@event("trial_started")
class TrialStarted:
    pass


@event("finish_reached")
class FinishReached:
    pass


@event("trial_finished")
class TrialFinished:
    trial: ContentRef[TrialDef]
    key: str
    seconds: float
    medal: Medal
    best: float
    new_best: bool


def current_trial(ctx) -> ContentRef[TrialDef] | None:
    return ctx.content(TrialDef).first(lambda t: ctx.scenes.current_is(t.scene))


def trial_key(ctx) -> str | None:
    """The records key of the running trial: its id, or "<id>:<variant>"."""
    trial = current_trial(ctx)
    if trial is None:
        return None
    variant = ctx.get(TrialRun).variant
    return f"{trial.id}:{variant}" if variant else trial.id


def medal_for(trial: TrialDef, seconds: float) -> Medal:
    if seconds <= trial.gold:
        return Medal.GOLD
    if seconds <= trial.silver:
        return Medal.SILVER
    if seconds <= trial.bronze:
        return Medal.BRONZE
    return Medal.NONE


def elapsed(ctx) -> float:
    run = ctx.get(TrialRun)
    if run.started_at < 0:
        return 0.0
    return run.finished_in if run.finished_in >= 0 else ctx.time.now - run.started_at


@system("trial_clock", scenes=[Playable], when=lambda ctx: current_trial(ctx) is not None)
class TrialClock(System):
    """Starts and stops the clock; records bests and medals."""

    def start(self, ctx):
        if ctx.config(TimeTrialConfig).auto_start and current_trial(ctx) is not None:
            ctx.get(TrialRun).started_at = ctx.time.now

    @on(TrialStarted)
    def started(self, ctx, e: TrialStarted):
        run = ctx.get(TrialRun)
        if run.started_at < 0:
            run.started_at = ctx.time.now

    @on(FinishReached)
    def finished(self, ctx, e: FinishReached):
        run = ctx.get(TrialRun)
        if run.started_at < 0 or run.finished_in >= 0:
            return
        run.finished_in = ctx.time.now - run.started_at
        trial, key = current_trial(ctx), trial_key(ctx)
        records = ctx.get(TrialRecords)
        medal = medal_for(trial.data, run.finished_in)
        previous = records.best.get(key, -1)
        new_best = previous < 0 or run.finished_in < previous
        if new_best:
            records.best[key] = run.finished_in
        if MEDAL_RANK[medal] > MEDAL_RANK[records.medals.get(key, Medal.NONE)]:
            records.medals[key] = medal
        ctx.emit(TrialFinished(trial=trial, key=key, seconds=run.finished_in, medal=medal,
                               best=records.best[key], new_best=new_best))


@ui("time_trial", html="ui/lib/time_trial.html", scenes=[Playable],
    when=lambda ctx: current_trial(ctx) is not None and ctx.config(TimeTrialConfig).show_timer)
class TrialTimer(Panel):
    def state(self, ctx):
        trial = current_trial(ctx)
        seconds = elapsed(ctx)
        best = ctx.get(TrialRecords).best.get(trial_key(ctx), -1)
        pace = medal_for(trial.data, seconds)
        return {
            "time": seconds,
            "has_best": best >= 0,
            "best": max(best, 0),
            "gold": trial.data.gold,
            "pace": pace.value,
            "finished": ctx.get(TrialRun).finished_in >= 0,
        }
