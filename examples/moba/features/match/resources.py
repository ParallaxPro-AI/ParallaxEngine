from parallax import field, resource


@resource("record", keep="profile")
class Record:
    """A player's win/loss record. A profile resource: on a dedicated server each
    player has their own, and each client reads its own."""
    wins: int = field(0)
    losses: int = field(0)
