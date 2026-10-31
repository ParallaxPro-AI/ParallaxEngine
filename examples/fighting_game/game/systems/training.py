from parallax import System, on, system
from parallax.combat import Health
from project import Content, Placed, Text

from game.callouts import call_out
from game.components import Challenger, Fighter
from game.content import Goal
from game.events import ExchangeResolved, LessonPassed, RunEnded
from game.resources import CalloutStyle, Match, Mode, Phase
from game.rules import Rules, current_lesson, fighting_in

in_lesson = fighting_in(Mode.TRAINING)


@system("training", when=in_lesson)
class Training(System):
    """Guided training: each lesson passes on the event that proves the player did it.
    `when=` is checked before every hook and handler, so once the last lesson ends the
    run, a second exchange in the same frame can't pass a lesson that doesn't exist."""

    def update(self, ctx, dt):
        rules = ctx.config(Rules)
        lesson = current_lesson(ctx)
        you = ctx.world.placed(Placed.challenger)
        fighter = you.get(Fighter)
        fighter.meter = max(fighter.meter, lesson.min_meter)
        walked = abs(you.transform.position.x + rules.start_x)
        if lesson.goal is Goal.WALK and walked > rules.lesson_walk_distance:
            self.pass_lesson(ctx)

    @on(ExchangeResolved, when=in_lesson)
    def exchanged(self, ctx, event: ExchangeResolved):
        goal = current_lesson(ctx).goal
        yours = event.attacker.has(Challenger)
        clean = yours and not event.blocked
        if (
            (goal is Goal.LAND_JAB and clean and event.move == Content.move.jab)
            or (goal is Goal.GUARD and not yours and event.blocked)
            or (goal is Goal.PUNISH and clean and event.punish)
            or (goal is Goal.LAND_SUPER and clean and event.move == Content.move.circuit_breaker)
        ):
            self.pass_lesson(ctx)

    def pass_lesson(self, ctx):
        match = ctx.get(Match)
        ctx.emit(LessonPassed(lesson=match.lesson))
        match.lesson += 1
        call_out(ctx, ctx.text(Text.lesson_passed), CalloutStyle.LESSON)
        if match.lesson == len(ctx.config(Rules).lessons):
            match.phase = Phase.OVER
            ctx.emit(RunEnded(won=True))
        else:
            ctx.world.placed(Placed.rival).get(Health).revive()
