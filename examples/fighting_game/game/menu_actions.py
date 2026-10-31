"""What the title card's, the moves panel's and the practice bar's buttons do.

Each is a plain-function panel action (see game/ui.py); typed parameters are filled
from the button's `data-*` attributes (`data-mode="training"` → `mode=Mode.TRAINING`).
Every run start reloads the arena carrying the chosen mode and rung, so the fighters,
the menus and this run's numbers are fresh without clearing anything by hand.
"""

from parallax import Context, Settings

from game.events import BoutStarted
from game.fighters import dress_challenger
from game.resources import Career, Dummy, Match, Mode, Phase, Preferences, RunStats
from game.rules import Rules


def start_run(ctx: Context, mode: Mode, stage: int = 0) -> None:
    """A new run in `mode`, from the first rival or lesson (or a given rung)."""
    ctx.scenes.reload(new_run=True, init=[Match(mode=mode, stage=stage, phase=Phase.INTRO)])


def continue_circuit(ctx: Context) -> None:
    """Resume the circuit at the career checkpoint."""
    start_run(ctx, Mode.CIRCUIT, ctx.get(Career).checkpoint)


def fight_again(ctx: Context) -> None:
    """FIGHT AGAIN: paused, restart this mode at this rival; after a lost circuit, go
    again from the rival who stopped you; after the belt, from the first rival."""
    match = ctx.get(Match)
    won = match.phase is Phase.OVER and ctx.get(RunStats).won
    start_run(ctx, match.mode, 0 if won else match.stage)


def cycle_difficulty(ctx: Context) -> None:
    """Step the difficulty to the next level."""
    prefs = ctx.get(Preferences)
    order = ctx.config(Rules).difficulties
    prefs.difficulty = order[(order.index(prefs.difficulty) + 1) % len(order)]


def toggle_shake(ctx: Context) -> None:
    """Camera shake on hits, which is the engine's reduced-motion setting."""
    settings = ctx.get(Settings)
    settings.reduced_motion = not settings.reduced_motion


def toggle_sound(ctx: Context) -> None:
    """Mute, or back to full volume."""
    settings = ctx.get(Settings)
    settings.master_volume = 0.0 if settings.master_volume > 0 else 1.0


def toggle_haptics(ctx: Context) -> None:
    prefs = ctx.get(Preferences)
    prefs.haptics = not prefs.haptics


def toggle_champion_kit(ctx: Context) -> None:
    """Once a belt is won: wear the amber champion kit, or go back to bone."""
    prefs = ctx.get(Preferences)
    prefs.champion_kit = not prefs.champion_kit
    dress_challenger(ctx)


def choose_dummy(ctx: Context, dummy: Dummy) -> None:
    """Practice: switch what the dummy does and restart the bout in place."""
    match = ctx.get(Match)
    match.dummy = dummy
    ctx.emit(BoutStarted(stage=match.stage))
