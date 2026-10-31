import random

from parallax import Context, System, Vec3, on, system, vec3
from project import Assets

from game.config import Cue, Rules, Rumble, Sounds
from game.events import ComboReached, KeyHit, KeyMissed, RunEnded, WordBreached, WordCleared, WordLocked
from game.resources import Run, ScorePop
from game.rules import field_point

POPS_KEPT = 6


@system("feedback")
class Feedback(System):
    """Sound, particles (on the firewall, in the word's column), shake, rumble, and the
    moments the HUD animates from (score pops, the wrong-letter shake, the combo bump and
    milestone stamp). Every effect answers an event the judge or firewall reported, so
    the room reacts to the player's typing, and none of it can touch the judgement. The
    menu music is the title scene's."""

    @on(KeyHit)
    def hit(self, ctx, event):
        play(ctx, ctx.config(Sounds).type)

    @on(KeyMissed)
    def missed(self, ctx, event):
        play(ctx, ctx.config(Sounds).error)
        ctx.get(Run).missed_at = ctx.time.now

    @on(WordLocked)
    def locked(self, ctx, event):
        play(ctx, ctx.config(Sounds).lock)
        ctx.vfx.play(Assets.vfx.lock_sparks, at=at_firewall(event.at, 0.7))
        rumble(ctx, ctx.config(Rules).lock_rumble)

    @on(WordCleared)
    def cleared(self, ctx, event):
        run = ctx.get(Run)
        play(ctx, ctx.config(Sounds).clear_word)
        ctx.vfx.play(Assets.vfx.purge_sparks, at=at_firewall(event.at, 0.7))
        rumble(ctx, ctx.config(Rules).purge_rumble)
        run.cleared_at = ctx.time.now
        pop = ScorePop(at=field_point(ctx, event.at), points=event.points, kind=event.kind, time=ctx.time.now)
        # A ring of slots, so each HUD pop keeps its element (and its animation) until it is reused.
        if len(run.pops) < POPS_KEPT:
            run.pops = run.pops + [pop]
        else:
            run.pops = [pop if i == (run.cleared - 1) % POPS_KEPT else p for i, p in enumerate(run.pops)]

    @on(WordBreached)
    def breached(self, ctx, event):
        rules = ctx.config(Rules)
        play(ctx, ctx.config(Sounds).breach)
        ctx.vfx.play(Assets.vfx.breach_smoke, at=at_firewall(event.at, 0.6))
        ctx.camera.main.shake(rules.breach_shake, seconds=rules.breach_shake_seconds)
        rumble(ctx, rules.breach_rumble)

    @on(ComboReached)
    def combo(self, ctx, event):
        run = ctx.get(Run)
        play(ctx, ctx.config(Sounds).combo)
        ctx.vfx.play(Assets.vfx.combo_burst, at=vec3(0, 2, -2))
        rumble(ctx, ctx.config(Rules).combo_rumble)
        run.milestone_at = ctx.time.now
        run.milestone = event.combo

    @on(RunEnded)
    def ended(self, ctx, event):
        rules = ctx.config(Rules)
        play(ctx, ctx.config(Sounds).fail)
        ctx.vfx.play(Assets.vfx.end_smoke, at=vec3(0, 1, -4))
        ctx.camera.main.shake(rules.end_shake, seconds=rules.end_shake_seconds)
        rumble(ctx, rules.end_rumble)


def play(ctx: Context, cue: Cue) -> None:
    ctx.audio.play(random.choice(cue.clips),
                   volume=random.uniform(cue.volume[0], cue.volume[-1]),
                   pitch=random.uniform(cue.pitch[0], cue.pitch[-1]))


def rumble(ctx: Context, buzz: Rumble) -> None:
    ctx.input.rumble(buzz.strength, buzz.seconds)


def at_firewall(at: Vec3, height: float) -> Vec3:
    """Bursts go off on the firewall, in the word's column."""
    return vec3(at.x, height, 0)
