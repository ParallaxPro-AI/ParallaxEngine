"""Run-wide combat state."""

from parallax import field, resource


@resource("run_stats")
class RunStats:
    """Kills and streaks for the end-of-run card."""

    kills: int = field(0)
    streak: int = field(0)
    best_streak: int = field(0)


@resource("hero_hurt", keep="scene")
class HeroHurt:
    """When the hero last took a hit: the HUD's coral edge flash fades over a quarter second from it."""

    at: float = field(-99, unit="s")


@resource("combat_hints", keep="scene")
class CombatHints:
    """The last weakness hint shown, so the same one is not repeated every swing."""

    last: str = field("")
    shown_at: float = field(-99, unit="s")
