from parallax import System, on, system
from project import Content, Scenes

from game.config import Board
from game.content import GradeDef, LegDef, TierDef, par_total
from game.darts import MISS, Hit, Outcome, Ring, countdown, score_dart
from game.events import DartLanded, DartScored, LegStarted, LegWon, MatchEnded, SkillsScored
from game.resources import Career, LegResult, Match, Result, Stage

PENALTIES = {Outcome.MISS: Content.penalty.miss, Outcome.BUST: Content.penalty.bust}


@system("scorekeeper", scenes=[Scenes.oche_hall])
class Scorekeeper(System):
    """Runs the card. Starts the first leg on its number, scores every dart
    against the countdown, pays skill shots and penalties, grades a checkout
    against par, and ends the match after the last leg or as soon as the dart
    budget is blown. The leg card and the result card follow `Match.stage`; the
    leg card's button starts the next leg (`begin_leg`)."""

    def start(self, ctx):
        ctx.get(Match).tier = ctx.content(TierDef)[ctx.get(Career).tier]
        begin_leg(ctx, 0)

    @on(DartLanded)
    def score_landing(self, ctx, event: DartLanded):
        match = ctx.get(Match)
        hit = score_dart(event.offset, ctx.config(Board)) if event.offset is not None else MISS
        match.darts += 1
        match.total_darts += 1
        match.last_hit = hit
        self.pay_skills(ctx, hit, event.clean)

        outcome = countdown(match.remaining, hit)
        penalty = PENALTIES.get(outcome)
        if outcome is Outcome.SCORED:
            match.remaining -= hit.value
        elif outcome is Outcome.BUST:
            match.busts += 1
        points = add_points(match, penalty.data.points) if penalty else 0
        ctx.emit(DartScored(hit=hit, outcome=outcome, penalty=penalty, points=points))

        if outcome is Outcome.CHECKOUT:
            match.remaining = 0
            self.win_leg(ctx)
        elif over_budget(ctx):
            self.end(ctx, Result.LOST)

    def pay_skills(self, ctx, hit: Hit, clean: bool):
        match = ctx.get(Match)
        skills = [Content.skill.pure_release] if clean else []
        if hit.ring is Ring.INNER_BULL:
            skills.append(Content.skill.bullseye)
            match.bullseyes += 1
        elif hit.ring is Ring.TREBLE and hit.number == 20:
            skills.append(Content.skill.maximum)
            match.maximums += 1
        elif hit.ring is Ring.TREBLE:
            skills.append(Content.skill.treble)
        elif hit.ring is Ring.DOUBLE:
            skills.append(Content.skill.double)
        if skills:
            points = add_points(match, sum(skill.data.points for skill in skills))
            ctx.emit(SkillsScored(skills=skills, points=points))

    def win_leg(self, ctx):
        match = ctx.get(Match)
        card = ctx.content(LegDef)
        leg = card[match.leg].data
        over_par = match.darts - leg.par
        grade = ctx.content(GradeDef).first(lambda grade: over_par <= grade.max_over_par)
        points = add_points(match, grade.data.points)
        match.card.append(LegResult(number=leg.number, darts=match.darts, over_par=over_par, grade=grade, points=points))
        ctx.emit(LegWon(grade=grade, points=points))

        checkout = Content.skill.checkout
        if leg.start >= checkout.data.min_start:
            ctx.emit(SkillsScored(skills=[checkout], points=add_points(match, checkout.data.points)))

        if over_budget(ctx):
            self.end(ctx, Result.LOST)
        elif match.leg + 1 == len(card):
            self.end(ctx, Result.WON)
        else:
            match.stage = Stage.LEG_WON

    def end(self, ctx, result: Result):
        match = ctx.get(Match)
        match.result = result
        match.stage = Stage.OVER
        ctx.emit(MatchEnded(won=result is Result.WON))


def begin_leg(ctx, index: int) -> None:
    """Put leg `index` of the card on the board: its number to count down, a
    fresh dart count, and `LegStarted` for the dart and the air."""
    match = ctx.get(Match)
    leg = ctx.content(LegDef)[index]
    match.leg = index
    match.stage = Stage.THROWING
    match.remaining = leg.data.start
    match.darts = 0
    match.last_hit = None
    ctx.emit(LegStarted(leg=leg))


def add_points(match: Match, points: int) -> int:
    """Every point goes through the tier's multiplier — penalties included."""
    gained = round(points * match.tier.data.score_mult)
    match.score += gained
    return gained


def over_budget(ctx) -> bool:
    match = ctx.get(Match)
    return match.total_darts > par_total(ctx) + match.tier.data.budget_over_par
