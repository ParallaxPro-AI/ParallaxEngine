"""Enemies and hazards."""

from parallax import System, TriggerEntered, on, system
from parallax.characters import Character
from project import Assets

from game.audio import Sounds, play
from game.components import Enemy, Hazard, Level, player_touches
from game.config import Rules
from game.events import DeathCause, PlayerDied
from game.resources import Attempt, Profile, alive


@system("dangers", scenes=[Level])
class Dangers(System):
    """Touching a hazard kills. Touching an enemy kills too, unless you come
    down on it from above: a stompable enemy is flattened for points and bounces
    you back up, keeping your run speed."""

    @on(TriggerEntered, when=alive, where=player_touches(Hazard))
    def hazard(self, ctx, event: TriggerEntered):
        ctx.emit(PlayerDied(cause=DeathCause.HAZARD))

    @on(TriggerEntered, when=alive, where=player_touches(Enemy))
    def enemy(self, ctx, event: TriggerEntered):
        rules = ctx.config(Rules)
        player, enemy = event.target, event.entity
        kind = enemy.get(Enemy).kind.data
        character = player.get(Character)
        above = player.transform.position.y > enemy.transform.position.y + rules.stomp_height
        if not (kind.stompable and above and character.velocity.y < -0.5):
            ctx.emit(PlayerDied(cause=DeathCause.ENEMY))
            return
        ctx.get(Attempt).score += kind.points
        ctx.ui.float_text(f"+{kind.points}", enemy.transform.position)
        ctx.vfx.play(Assets.vfx.dust, at=enemy)
        play(ctx, ctx.config(Sounds).stomp)
        if ctx.get(Profile).shake:
            ctx.camera.main.shake(0.1, 0.1)
        character.launch(character.velocity.with_y(rules.stomp_bounce))
        enemy.destroy()
