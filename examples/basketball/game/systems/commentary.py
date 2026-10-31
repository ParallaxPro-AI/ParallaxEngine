from parallax import System, on, system, vec3
from project import Assets, Text

from game.components import Home, You
from game.content import CourtRules, Sounds
from game.events import (
    BallStolen, BucketIncoming, BucketScored, GameDecided, PeriodEnded, PeriodStarted, ReboundClaimed, ShotClockExpired, ShotMissed,
)
from game.resources import Match, Run
from game.rules import crew, hoop_defended_by, rival, team_of


def banner(ctx, title: str, subtitle: str = "", tint: str = "var(--cc-chalk)") -> None:
    """The scoreboard's banner (the template's _show_banner): chalk for a ruling,
    accent for the game's big beats, a team colour for a bucket."""
    match = ctx.get(Match)
    match.banner, match.banner_sub, match.banner_tint, match.banner_at = title, subtitle, tint, ctx.time.now


def css(color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


@system("commentary")
class Commentary(System):
    """Banners, call-outs, sounds and effects. Changes no game state."""

    @on(PeriodStarted)
    def period_started(self, ctx, event):
        match = ctx.get(Match)
        if event.quarter == 1:
            tonight = crew(ctx)
            banner(ctx, ctx.text(Text.game_of, number=ctx.get(Run).stage + 1,
                                 total=len(ctx.config(CourtRules).ladder)),
                   ctx.text(Text.crew_taunt, crew=ctx.text(tonight.name), taunt=ctx.text(tonight.taunt)),
                   "var(--cc-accent)")
        elif match.overtime:
            banner(ctx, ctx.text(Text.overtime, number=match.overtime),
                   ctx.text(Text.tied, home=match.home_score, away=match.away_score), "var(--cc-accent)")
        else:
            banner(ctx, ctx.text(Text.quarter, number=event.quarter))

    @on(PeriodEnded)
    def period_ended(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).quarter_end)
        banner(ctx, ctx.text(Text.end_of_quarter, number=event.quarter))

    @on(BucketScored)
    def bucket(self, ctx, event):
        rim = hoop_defended_by(ctx, rival(team_of(event.shooter)))
        title = Text.three if event.points == ctx.config(CourtRules).three_points else Text.bucket
        match = ctx.get(Match)
        score = f"{match.home_score}\u2013{match.away_score}"
        subtitle = f"{ctx.text(Text.assisted)} · {score}" if event.assist is not None else score
        home = team_of(event.shooter) is Home
        banner(ctx, ctx.text(title), subtitle, "var(--cc-home)" if home else css(crew(ctx).color))
        ctx.ui.float_text(f"+{event.points}", rim + vec3(0, 1.6, 0))
        ctx.audio.play(ctx.config(Sounds).shot_make, at=rim)
        ctx.audio.play(ctx.config(Sounds).bucket_fanfare)
        ctx.vfx.play(Assets.vfx.net_sparkle, at=rim)
        ctx.camera.main.shake(0.12, 0.15)

    @on(BucketIncoming)
    def slow_motion(self, ctx, event):
        """The bucket cam's slow-mo dip: the ball arcs in at 0.4 speed for the dagger."""
        ctx.hud.slow_motion(0.4, 2.2)

    @on(ShotMissed)
    def miss(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).shot_miss, at=event.shooter)

    @on(ReboundClaimed)
    def rebound(self, ctx, event):
        ctx.ui.float_text(ctx.text(Text.rebound), event.by.transform.position + vec3(0, 2.1, 0))

    @on(BallStolen)
    def steal(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).steal, at=event.by)
        ctx.ui.float_text(ctx.text(Text.steal), event.by.transform.position + vec3(0, 2.1, 0))
        if event.by.has(You):
            ctx.camera.main.shake(0.18, 0.16)

    @on(ShotClockExpired)
    def violation(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).bounce)
        banner(ctx, ctx.text(Text.shot_clock), ctx.text(Text.turnover))

    @on(GameDecided)
    def final_buzzer(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).match_end)
