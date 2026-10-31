from parallax import field, resource


@resource("run")
class Run:
    """One attempt. `keep="run"` (the default) means Retry's `reload_scene(new_run=True)`
    puts every field back to its default."""
    time: float = field(0.0, doc="Seconds survived.")
    until_spawn: float = field(0.0, doc="Seconds until the next rock.")
    over: bool = field(False)


@resource("best", keep="profile")
class Best:
    """Kept across runs (and saved with the player's profile)."""
    score: int = field(0)


def score(run: Run) -> int:
    """The score is whole seconds survived."""
    return int(run.time)


def run_over(ctx) -> bool:
    return ctx.get(Run).over


def in_play(ctx) -> bool:
    return not ctx.get(Run).over
