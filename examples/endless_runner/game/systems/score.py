"""The economy: coins, the combo, style and the run goal."""

from parallax import System, Vec3, on, system
from project import Assets, Scenes, Text

from game.audio import Sounds, play
from game.config import Rules
from game.content import PowerUpEffect
from game.events import CoinsEarned, CoinTaken, NearMissed, ObstacleSmashed, Stumbled
from game.resources import Profile, Run, buff, running


@system("score", scenes=[Scenes.street], when=running)
class Score(System):
    """Score is distance plus coins plus style (near misses). Every coin and
    every near miss feeds the combo; each `combo_step` of them raises it, up to
    `combo_max`, and it multiplies every coin (as does a double-coins buff). A
    stumble breaks it. Coins are banked the instant you take them, so a busted
    run still pays. Clearing the run goal (a distance with a combo held) pays a
    bonus once per run."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.score = int(run.distance + run.coins * rules.coin_score + run.style * rules.style_score)
        if not run.mission_paid and run.distance >= rules.mission_distance and run.best_combo >= rules.mission_combo:
            run.mission_paid = True
            self.earn(ctx, rules.mission_reward)
            ctx.ui.toast(ctx.text(Text.toast_mission, coins=rules.mission_reward))
        profile = ctx.get(Profile)
        if not profile.tutorial_done and run.learned_lane and run.learned_jump and run.learned_slide:
            profile.tutorial_done = True

    @on(CoinTaken)
    def coin(self, ctx, event: CoinTaken):
        run = ctx.get(Run)
        double = buff(ctx, PowerUpEffect.SCORE_MULTIPLIER)
        multiplier = double.power if double else 1
        self.earn(ctx, max(1, round(run.combo * multiplier * run.coin_value)))
        self.feed_combo(ctx, run)
        play(ctx, ctx.config(Sounds).coin)
        ctx.vfx.play(Assets.vfx.sparkle, at=event.at)

    @on(NearMissed)
    def near_miss(self, ctx, event: NearMissed):
        run = ctx.get(Run)
        run.style += 1
        self.feed_combo(ctx, run)
        play(ctx, ctx.config(Sounds).near_miss)
        ctx.vfx.play(Assets.vfx.dust, at=event.at + Vec3(0, 1.1, 0))

    @on(ObstacleSmashed)
    def smashed(self, ctx, event: ObstacleSmashed):
        self.earn(ctx, max(1, round(ctx.get(Run).coin_value)))
        play(ctx, ctx.config(Sounds).smash)
        ctx.vfx.play(Assets.vfx.sparks, at=event.at + Vec3(0, 0.5, 0))

    @on(Stumbled)
    def stumbled(self, ctx, event: Stumbled):
        run = ctx.get(Run)
        run.combo, run.combo_progress = 1, 0

    def earn(self, ctx, amount: int):
        ctx.get(Run).coins += amount
        ctx.emit(CoinsEarned(amount=amount))

    def feed_combo(self, ctx, run: Run):
        rules = ctx.config(Rules)
        if run.combo >= rules.combo_max:
            return
        run.combo_progress += 1
        if run.combo_progress < rules.combo_step:
            return
        run.combo_progress = 0
        run.combo += 1
        run.best_combo = max(run.best_combo, run.combo)
        play(ctx, ctx.config(Sounds).combo_up)
