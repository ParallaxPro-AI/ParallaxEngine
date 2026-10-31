"""One attempt at a level: the clock, lives, deaths, respawns and the finish."""

from parallax import System, TriggerEntered, on, system, vec3
from parallax.characters import Character
from project import Assets, Content, Text

from game.audio import Sounds, play
from game.components import Collectible, Goal, Level, Player, player_touches
from game.config import Rules
from game.content import LevelDef
from game.events import DeathCause, LevelFinished, PlayerDied, Respawned
from game.resources import Attempt, Mode, Profile, alive, playing


@system("level_rules", scenes=[Level], when=playing)
class LevelRules(System):
    """Owns an attempt. Falling below the kill plane, a hazard or an enemy
    kills you; the hero stops where it fell, and after a short beat (a saved
    deadline, `respawn_at`) you respawn at the last checkpoint with a moment of
    grace. In Challenge mode each death costs a life and the last one fails the
    level. Touching the sky gate clears it: a goal bonus, a bonus per life left,
    a time bonus under par, and up to three stars (clear it; find all three
    keepsakes; beat par without dying). Either way the results panel opens on
    its own."""

    def start(self, ctx):
        level = ctx.content(LevelDef).first(lambda data: ctx.scenes.current_is(data.scene))
        attempt = ctx.get(Attempt)
        attempt.level = level
        attempt.lives = ctx.config(Rules).start_lives
        attempt.started_at = ctx.time.now
        attempt.spawn = ctx.world.query(tagged=Player).single().transform.position
        attempt.keepsakes_total = (
            ctx.world.query(Collectible)
            .where(lambda entity, item: item.kind == Content.collectible.keepsake)
            .count()
        )
        ctx.ui.announce(level.data.name, level.data.subtitle, seconds=3)

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        attempt = ctx.get(Attempt)
        if attempt.dead:
            if ctx.time.now >= attempt.respawn_at:
                self.respawn(ctx)
            return
        if ctx.time.now > attempt.chain_until:
            attempt.chain = 1.0
        position = ctx.world.query(tagged=Player).single().transform.position
        if position.y < rules.kill_plane:
            ctx.emit(PlayerDied(cause=DeathCause.FELL))
        elif attempt.tips_shown < len(rules.tips) and position.x >= attempt.tips_shown * rules.tip_spacing:
            self.notice(ctx, ctx.text(rules.tips[attempt.tips_shown]), seconds=6)
            attempt.tips_shown += 1

    @on(PlayerDied, when=alive)
    def died(self, ctx, event: PlayerDied):
        attempt = ctx.get(Attempt)
        if ctx.time.now < attempt.grace_until:
            return
        attempt.dead = True
        attempt.deaths += 1
        attempt.chain = 1.0
        player = ctx.world.query(tagged=Player).single()
        player.get(Character).stop()
        ctx.vfx.play(Assets.vfx.smoke, at=player)
        play(ctx, ctx.config(Sounds).hurt)
        ctx.ui.flash(player, seconds=0.3)
        if ctx.get(Profile).shake:
            ctx.camera.main.shake(0.18, 0.18)
        if ctx.get(Profile).mode is Mode.CHALLENGE:
            attempt.lives -= 1
            if attempt.lives == 0:
                self.finish(ctx, won=False)
                return
        attempt.respawn_at = ctx.time.now + ctx.config(Rules).death_pause
        self.notice(ctx, ctx.text(Text.notice_respawn), seconds=3)

    def respawn(self, ctx):
        rules = ctx.config(Rules)
        attempt = ctx.get(Attempt)
        attempt.dead = False
        attempt.grace_until = ctx.time.now + rules.respawn_grace
        player = ctx.world.query(tagged=Player).single()
        ctx.emit(Respawned(entity=player, at=attempt.spawn + vec3(0, rules.respawn_lift, 0)))

    @on(TriggerEntered, when=alive, where=player_touches(Goal))
    def reached_gate(self, ctx, event: TriggerEntered):
        self.finish(ctx, won=True)

    def finish(self, ctx, won: bool):
        rules = ctx.config(Rules)
        attempt = ctx.get(Attempt)
        level = attempt.level.data
        attempt.ended, attempt.won = True, won
        attempt.time = ctx.time.now - attempt.started_at
        if won:
            attempt.time_bonus = max(0, int((level.par_time - attempt.time) * rules.time_bonus_per_second))
            attempt.score += rules.goal_bonus + attempt.lives * rules.lives_bonus + attempt.time_bonus
            clean_and_quick = attempt.time <= level.par_time and attempt.deaths == 0
            attempt.stars = 1 + int(attempt.keepsakes == attempt.keepsakes_total) + int(clean_and_quick)
            play(ctx, ctx.config(Sounds).fanfare)
        else:
            play(ctx, ctx.config(Sounds).fail)
        ctx.audio.music(None)
        ctx.emit(LevelFinished(level=attempt.level, won=won))

    def notice(self, ctx, message: str, seconds: float):
        attempt = ctx.get(Attempt)
        attempt.notice, attempt.notice_until = message, ctx.time.now + seconds
