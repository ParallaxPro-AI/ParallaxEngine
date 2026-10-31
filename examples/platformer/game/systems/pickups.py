"""Coins, gems, hearts and keepsakes."""

from parallax import System, TriggerEntered, on, system, vec3
from project import Assets, Text

from game.components import Collectible, Level, player_touches
from game.config import Rules
from game.content import CollectibleKind
from game.resources import Attempt, alive


@system("pickups", scenes=[Level])
class Pickups(System):
    """Collecting a coin or gem scores its points times the chain, and extends
    the chain: grab the next within `chain_window` and the multiplier climbs.
    A heart restores a life (up to the cap). Keepsakes are the three hidden
    finds per level, one star's worth together."""

    @on(TriggerEntered, when=alive, where=player_touches(Collectible))
    def collected(self, ctx, event: TriggerEntered):
        attempt = ctx.get(Attempt)
        pickup = event.entity.get(Collectible).kind.data
        at = event.entity.transform.position
        event.entity.destroy()
        ctx.audio.play(pickup.sound, volume=pickup.volume)
        if pickup.kind is CollectibleKind.HEART:
            attempt.lives = min(ctx.config(Rules).max_lives, attempt.lives + 1)
            ctx.vfx.play(Assets.vfx.heal, at=at)
        elif pickup.kind is CollectibleKind.KEEPSAKE:
            attempt.keepsakes += 1
            ctx.ui.toast(ctx.text(Text.notice_keepsake, found=attempt.keepsakes))
        else:
            self.score(ctx, attempt, pickup.points, at)

    def score(self, ctx, attempt: Attempt, points: int, at):
        rules = ctx.config(Rules)
        if ctx.time.now <= attempt.chain_until:
            attempt.chain = min(rules.chain_max, attempt.chain + rules.chain_step)
        attempt.chain_until = ctx.time.now + rules.chain_window
        gained = round(points * attempt.chain)
        attempt.score += gained
        attempt.coins += 1
        ctx.ui.float_text(f"+{gained}", at + vec3(0, 1.2, 0))
