from parallax import Vec3, field, resource


@resource("run")
class Run:
    """This world's survival record. A challenge run starts with
    `init=[Run(challenge=True)]`."""
    challenge: bool = field(False, doc="Limited lives; see Rules.lives.")
    deaths: int = field(0, min=0)
    home: Vec3 | None = field(None, doc="Where you wake up: beside your bed.")
