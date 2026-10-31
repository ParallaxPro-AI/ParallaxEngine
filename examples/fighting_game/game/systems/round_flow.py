from parallax import Model, SceneLoaded, System, on, system
from parallax.characters import Character
from parallax.combat import Died, Health
from project import Assets, Placed

from game.components import Bolt, Corner, Fighter, FighterState
from game.events import BoutEnded, BoutStarted, RoundEnded, RunEnded
from game.fighters import corner_of, dress_challenger, reset_fighter
from game.resources import Match, Mode, Phase
from game.rules import Rules, current_rival, fighting, run_in_progress


@system("round_flow")
class RoundFlow(System):
    """Runs a bout: round intro, the fight clock, K.O. or time-out, best of three,
    then the next rival or the end of the run. Draws replay the round. The HUD's banner
    reads the phase, the round's winner and whether it timed out."""

    @on(SceneLoaded)
    def dress(self, ctx, event: SceneLoaded):
        """The arena behind the title shows your kit too."""
        dress_challenger(ctx)

    @on(SceneLoaded, when=run_in_progress)
    def run_started(self, ctx, event: SceneLoaded):
        """Every run start reloads the arena with the run's mode and rung already in
        `Match` (game/menu_actions.py); the title is the same load with no run."""
        ctx.emit(BoutStarted(stage=ctx.get(Match).stage))

    @on(BoutStarted)
    def bout_started(self, ctx, event: BoutStarted):
        match = ctx.get(Match)
        match.round = 1
        match.challenger_wins = 0
        match.rival_wins = 0
        rival = current_rival(ctx)
        rival_entity = ctx.world.placed(Placed.rival)
        rival_entity.get(Model).set_option("kit", rival.kit)
        rival_entity.get(Character).walk_speed = rival.walk_speed
        self.start_round(ctx, match)

    def start_round(self, ctx, match):
        rules = ctx.config(Rules)
        self.clear_bolts(ctx)
        starting_meter = 0 if match.mode is Mode.CIRCUIT else rules.meter_max
        reset_fighter(ctx.world.placed(Placed.challenger), -rules.start_x, starting_meter)
        reset_fighter(ctx.world.placed(Placed.rival), rules.start_x, 0)
        match.phase = Phase.INTRO
        match.phase_timer.restart(rules.intro_seconds)
        match.clock = rules.round_seconds
        ctx.audio.play(Assets.sfx.round_bell)

    def update(self, ctx, dt):
        match = ctx.get(Match)
        if match.phase is Phase.INTRO and match.phase_timer.tick(dt):
            match.phase = Phase.FIGHT
            ctx.audio.play(Assets.sfx.fight_horn)
        elif match.phase is Phase.ROUND_OVER and match.phase_timer.tick(dt):
            self.after_round(ctx, match)
        elif match.phase is Phase.FIGHT and match.mode is Mode.CIRCUIT:
            match.clock = max(0.0, match.clock - dt)
            if match.clock == 0:
                self.end_round(ctx, match, self.leader(ctx))

    @on(Died, when=fighting, where=lambda event: event.entity.has(Fighter))
    def knocked_out(self, ctx, event: Died):
        loser = corner_of(event.entity)
        self.end_round(ctx, ctx.get(Match), Corner.RIVAL if loser is Corner.CHALLENGER else Corner.CHALLENGER)

    def leader(self, ctx) -> Corner | None:
        you = ctx.world.placed(Placed.challenger).get(Health).current
        rival = ctx.world.placed(Placed.rival).get(Health).current
        if you == rival:
            return None
        return Corner.CHALLENGER if you > rival else Corner.RIVAL

    def end_round(self, ctx, match, winner: Corner | None):
        match.phase = Phase.ROUND_OVER
        match.phase_timer.restart(ctx.config(Rules).round_end_seconds)
        match.round_winner = winner
        match.timed_out = match.clock == 0
        ctx.audio.play(Assets.sfx.ko_horn)
        if winner is Corner.CHALLENGER:
            match.challenger_wins += 1
        elif winner is Corner.RIVAL:
            match.rival_wins += 1
        for entity, fighter in ctx.world.query(Fighter):
            fighter.move = None
            if winner is None:
                fighter.state = FighterState.NEUTRAL
            else:
                fighter.state = FighterState.VICTORY if corner_of(entity) is winner else FighterState.KO
        self.clear_bolts(ctx)
        ctx.emit(RoundEnded(winner=winner))

    def after_round(self, ctx, match):
        rules = ctx.config(Rules)
        if match.challenger_wins >= rules.rounds_to_win:
            ctx.emit(BoutEnded(stage=match.stage, won=True))
            if match.stage == len(rules.ladder) - 1:
                self.finish(ctx, match, won=True)
            else:
                match.stage += 1
                ctx.emit(BoutStarted(stage=match.stage))
        elif match.rival_wins >= rules.rounds_to_win:
            ctx.emit(BoutEnded(stage=match.stage, won=False))
            self.finish(ctx, match, won=False)
        else:
            match.round += 1
            self.start_round(ctx, match)

    def finish(self, ctx, match, won):
        match.phase = Phase.OVER
        ctx.emit(RunEnded(won=won))

    def clear_bolts(self, ctx):
        for bolt in ctx.world.query(Bolt).entities():
            bolt.destroy()
