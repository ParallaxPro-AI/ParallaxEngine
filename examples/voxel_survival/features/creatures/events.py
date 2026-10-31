from parallax import event


@event("wave_started")
class WaveStarted:
    wave: int


@event("beacon_held")
class BeaconHeld: ...
