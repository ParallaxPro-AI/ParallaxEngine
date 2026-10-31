from parallax import System, system

from game.feed import Feed


@system("feed_clock", when=lambda ctx: bool(ctx.get(Feed).lines))
class FeedClock(System):
    """Ages the HUD's toast lines and drops each when its time is up."""

    def update(self, ctx, dt):
        feed = ctx.get(Feed)
        for line in feed.lines:
            line.left -= dt
        feed.lines = [line for line in feed.lines if line.left > 0]
