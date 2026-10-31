from parallax import event


@event("bumped")
class Bumped:
    total: int
