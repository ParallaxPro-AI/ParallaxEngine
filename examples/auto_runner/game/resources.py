"""Game-wide state: the current run, the hazard feeder's bookkeeping, the profile."""

from parallax import ContentRef, field, resource
from project import Content

from game.content import ObstacleDef, OutfitDef, StageDef


@resource("run")
class Run:
    """One run down the canyon. Retry (`new_run=True`) clears all of it except
    the mode, which is a choice made for the session."""

    endless: bool = field(False, keep="session")
    speed: float = field(0, unit="m/s")
    distance: float = field(0, unit="m")
    stage: ContentRef[StageDef] = field(Content.stage.flats)
    coins: int = field(0)
    streak: int = field(0)
    multiplier: int = field(1)
    feedback: str = field("")
    feedback_until: float = field(0, unit="s")
    stage_at: float = field(0, unit="s", doc="When the current stage began: the HUD's stage banner shows for 2.6 s.")
    over: bool = field(False)
    won: bool = field(False)
    killer: ContentRef[ObstacleDef] | None = field(None)
    card_at: float = field(0, unit="s", doc="When the end card opens: a beat after the run ends.")
    new_best: bool = field(False)


def running(ctx) -> bool:
    """Run condition for whatever drives a run: true until it ends."""
    return not ctx.get(Run).over


@resource("feed")
class Feed:
    """Where the hazard feeder is in its rhythm (systems keep no fields)."""

    since_spawn: float = field(0, unit="m")
    next_gap: float = field(0, unit="m")
    next_kind: ContentRef[ObstacleDef] = field(Content.obstacle.rock)
    gate_placed: bool = field(False)


@resource("profile", keep="profile")
class Profile:
    """The meta game. Kept on the device forever."""

    best_journey: int = field(0, unit="m")
    best_endless: int = field(0, unit="m")
    wins: int = field(0)
    endless_unlocked: bool = field(False, doc="Earned by finishing the Journey.")
    wallet: int = field(0)
    owned: list[ContentRef[OutfitDef]] = field([Content.outfit.courier])
    outfit: ContentRef[OutfitDef] = field(Content.outfit.courier)
