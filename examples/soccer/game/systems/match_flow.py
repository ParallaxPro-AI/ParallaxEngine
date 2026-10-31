from parallax import Context, Model, System, TriggerEntered, Vec3, on, system
from parallax.characters import Character
from parallax.physics import Rigidbody
from project import Placed, Text

from game.audio import Sounds, play
from game.components import Away, Ball, Footballer, Goal, Home, Stamina
from game.content import CupRules
from game.events import GoalScored, RoundStarted, TieDecided
from game.resources import Match, Phase, playing
from game.rules import opponent, rival
from game.training import fresh_legs_at_kickoff, kickoff_at_your_feet


@system("match_flow")
class MatchFlow(System):
    """The referee: kickoffs, the clock, goals, half time, golden goal, the final whistle.

    A tie is two halves. Level at full time, it goes to golden goal: score and you
    are through, let that clock run out and you are out. Every pause in play is a
    countdown on Match.phase_left; when it runs out play resumes or restarts."""

    def start(self, ctx):
        for player, footballer in ctx.world.query(Footballer):
            footballer.kickoff = player.transform.position
        self.begin_tie(ctx)

    @on(RoundStarted)
    def next_round(self, ctx, event):
        self.begin_tie(ctx)

    def update(self, ctx, dt):
        match = ctx.get(Match)
        if match.phase is Phase.PLAYING:
            self.run_clock(ctx, match, dt)
        elif match.phase is not Phase.DECIDED:
            match.phase_left -= dt
            if match.phase_left <= 0:
                self.resume(ctx, match)

    @on(TriggerEntered, when=playing, where=lambda event: event.entity.has(Goal) and event.target.has(Ball))
    def ball_in_net(self, ctx, event):
        match = ctx.get(Match)
        scorer = rival(event.entity.get(Goal).defended_by)
        if scorer is Home:
            match.home_goals += 1
        else:
            match.away_goals += 1
        self.stop_play(match, Phase.GOAL, ctx.config(CupRules).celebration_seconds)
        ctx.emit(GoalScored(team=scorer, goal=event.entity))

    def begin_tie(self, ctx: Context) -> None:
        """A fresh scoreline and clock against this round's opponent, captain on the ball."""
        foe = opponent(ctx)
        ctx.reset(Match)
        match = ctx.get(Match)
        match.clock = foe.half_seconds
        match.controlled = ctx.world.placed(Placed.captain)
        # The template's set_color: the whole kit, every material, in the shirt colour.
        for _, model in ctx.world.query(Model, tagged=Away):
            model.colors = {name: foe.shirt for name in model.colors}
        ctx.ui.announce(foe.stage, ctx.text(Text.versus, opponent=ctx.text(foe.name)),
                        seconds=ctx.config(CupRules).kickoff_seconds)
        self.kick_off(ctx, match)

    def kick_off(self, ctx: Context, match: Match) -> None:
        """Everyone back to their slot, the ball on the spot, count them in."""
        self.stop_play(match, Phase.KICKOFF, ctx.config(CupRules).kickoff_seconds)
        for _, footballer, character in ctx.world.query(Footballer, Character):
            character.teleport(footballer.kickoff)
        if fresh_legs_at_kickoff(ctx):
            for _, stamina in ctx.world.query(Stamina):
                stamina.current = stamina.max
                stamina.blown = False
        self.place_ball(ctx, match)
        play(ctx, ctx.config(Sounds).whistle)

    def place_ball(self, ctx: Context, match: Match) -> None:
        """On the centre spot, or at your feet if the squad drilled set pieces."""
        _, ball, body = ctx.world.query(Ball, Rigidbody).single()
        spot = ctx.world.placed(Placed.centre_spot).transform.position
        ball.holder = None
        if kickoff_at_your_feet(ctx):
            ball.holder = match.controlled
            spot = match.controlled.transform.position.with_y(spot.y) + Vec3.RIGHT * ball.carry_ahead
        body.teleport(spot)

    def resume(self, ctx: Context, match: Match) -> None:
        """A countdown ran out: start play, settle a golden goal, or line up again."""
        if match.phase is Phase.KICKOFF:
            match.phase = Phase.PLAYING
            play(ctx, ctx.config(Sounds).whistle_go)
        elif match.phase is Phase.GOAL and match.golden:
            self.decide(ctx, match, won=match.home_goals > match.away_goals)
        else:
            self.kick_off(ctx, match)

    def run_clock(self, ctx: Context, match: Match, dt: float) -> None:
        match.clock -= dt
        if match.clock > 0:
            return
        cup = ctx.config(CupRules)
        if match.golden:
            self.decide(ctx, match, won=False)
        elif match.half < cup.halves:
            match.half += 1
            match.clock = opponent(ctx).half_seconds
            self.stop_play(match, Phase.BREAK, cup.half_time_seconds)
            ctx.ui.announce(Text.half_time,
                            ctx.text(Text.score_line, home=match.home_goals, away=match.away_goals),
                            seconds=cup.half_time_seconds)
            play(ctx, ctx.config(Sounds).whistle)
        elif match.home_goals != match.away_goals:
            self.decide(ctx, match, won=match.home_goals > match.away_goals)
        else:
            match.golden = True
            match.clock = cup.golden_goal_seconds
            self.stop_play(match, Phase.BREAK, cup.golden_intro_seconds)
            ctx.ui.announce(Text.golden_goal, Text.golden_goal_hint, seconds=cup.golden_intro_seconds)
            play(ctx, ctx.config(Sounds).whistle)

    def stop_play(self, match: Match, phase: Phase, seconds: float) -> None:
        match.phase = phase
        match.phase_left = seconds

    def decide(self, ctx: Context, match: Match, won: bool) -> None:
        match.phase = Phase.DECIDED
        play(ctx, ctx.config(Sounds).full_time)
        ctx.emit(TieDecided(won=won))
