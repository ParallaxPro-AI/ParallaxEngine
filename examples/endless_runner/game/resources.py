"""Game-wide state: the run, the street generator's bookkeeping, the profile."""

from parallax import ContentRef, field, resource
from project import Content

from game.content import DistrictDef, PowerUpDef, PowerUpEffect, UpgradeDef


@resource("run")
class Run:
    """One escape attempt. Retry (`new_run=True`) clears all of it except the
    mode, which is a choice made for the session."""

    endless: bool = field(False, keep="session", doc="Night Shift: the districts loop forever.")
    hold_until: float = field(0, unit="s", doc="The countdown: nobody moves until then.")
    distance: float = field(0, unit="m")
    district: ContentRef[DistrictDef] = field(Content.district.market_row)
    lap: int = field(0, doc="Night Shift loops the districts.")
    coins: int = field(0)
    style: int = field(0, doc="Near misses.")
    score: int = field(0)
    combo: int = field(1)
    combo_progress: int = field(0)
    best_combo: int = field(1)
    buffs: dict[ContentRef[PowerUpDef], float] = field({}, doc="Timed power-ups and when each runs out.")
    shields: int = field(0)
    guard_gap: float = field(0, unit="m")
    hit_cooldown_until: float = field(0, unit="s")
    mission_paid: bool = field(False)
    learned_lane: bool = field(False, doc="First-run coach: changed lane this run.")
    learned_jump: bool = field(False)
    learned_slide: bool = field(False)
    over: bool = field(False)
    won: bool = field(False)
    card_at: float = field(0, unit="s", doc="When the end card opens: a beat after the run ends.")
    new_best: bool = field(False)
    prev_best_distance: int = field(0, unit="m", doc="The furthest run before this one, for the end card.")
    # Modifiers bought at the Lock-Up, applied when the run starts.
    gap_max: float = field(0, unit="m")
    recover_bonus: float = field(0, unit="m/s")
    passive_magnet: float = field(0, unit="m")
    coin_value: float = field(1.0)
    powerup_bonus: float = field(0.0)


def running(ctx) -> bool:
    """True until the run ends."""
    return not ctx.get(Run).over


def live(ctx) -> bool:
    """True while the runner is running: after the count-in, before the end."""
    run = ctx.get(Run)
    return not run.over and ctx.time.now >= run.hold_until


def buff(ctx, effect: PowerUpEffect) -> PowerUpDef | None:
    """The timed power-up with this effect that's running now, if any."""
    for kind, until in ctx.get(Run).buffs.items():
        if kind.data.effect is effect and ctx.time.now < until:
            return kind.data
    return None


@resource("street")
class Street:
    """Where the generator has built up to (systems keep no fields)."""

    road_z: float = field(0, unit="m")
    building_z: float = field(0, unit="m")
    obstacle_z: float = field(0, unit="m")
    pattern_step: int = field(0)
    finish_placed: bool = field(False)


@resource("profile", keep="profile")
class Profile:
    """Records, the wallet and Lock-Up upgrades. Kept on the device forever."""

    best_score: int = field(0)
    best_distance: int = field(0, unit="m")
    best_combo: int = field(1)
    escapes: int = field(0)
    endless_unlocked: bool = field(False, doc="Earned by the first escape.")
    tutorial_done: bool = field(False, doc="The first-run coach taught lane, jump and slide.")
    wallet: int = field(0)
    upgrades: dict[ContentRef[UpgradeDef], int] = field({})
