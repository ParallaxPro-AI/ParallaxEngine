"""The voyage's beats. They fire on the server."""

from parallax import event


@event("leg_started")
class LegStarted:
    leg: int


@event("voyage_ended")
class VoyageEnded:
    won: bool
