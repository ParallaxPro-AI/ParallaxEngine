"""How times read on screen."""


def format_time(seconds: float) -> str:
    """1:07.42, or --:-- for a time not set yet."""
    if seconds <= 0:
        return "--:--"
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes)}:{rest:05.2f}"
