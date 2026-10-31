from parallax import Timer, field, resource


@resource("payday")
class Payday:
    """Rings once a second while the match runs (a system can't hold its own Timer)."""
    timer: Timer = field(Timer.delay(1, repeat=True), keep="scene")
