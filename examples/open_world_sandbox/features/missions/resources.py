"""What the job in progress needs beyond its quest's steps, and the board's latest message."""

from parallax import TextRef, Timer, field, resource


@resource("job")
class Job:
    """Which job is running is its quest's status; this holds what quest state can't. A running job is
    never saved — saving is refused until it ends — so failing or finishing one simply resets it."""

    loaded_for: float = field(0, min=0, unit="s", doc="How long the car has held still in the bay.")
    clock: Timer = field(Timer.cooldown(0), doc="A getaway's window; done when no clock is running.")
    notice: TextRef | None = field(None, doc="The board's latest message.")
