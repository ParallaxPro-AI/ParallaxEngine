from parallax import field, resource


@resource("wave_clock")
class WaveClock:
    number: int = field(0, replicate=True)
    next_in: float = field(0, unit="s", replicate=True)
