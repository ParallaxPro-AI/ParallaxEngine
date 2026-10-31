"""The crews talk: your mate and tonight's rivals call short lines on real game moments
(library piece `barks` shows and paces them; the lines are content/bark/*.json)."""

import random

from parallax import Entity, System, Tag, field, on, resource, system

from game.components import Ball, Bot, Home, You
from game.content import CourtRules
from game.events import BallStolen, BucketScored, ShotMissed
from game.lib.barks import BarkRequested
from game.resources import playing
from game.rules import nearest_opponent_distance, team_of


def voice_of(ctx, team: Tag, prefer: Entity | None = None) -> Entity | None:
    """A bot on `team` to say it: `prefer` when it's one of them (the stealer, the
    shooter), else the first one (you never bark; your mate speaks for you)."""
    if prefer is not None and prefer.has(Bot) and team_of(prefer) is team:
        return prefer
    bots = ctx.world.query(Bot, tagged=team).entities()
    return bots[0] if bots else None


@resource("open_call", keep="scene")
class OpenCall:
    """Who last called "I'm open!" to which carrier, so a caller calls once per look."""
    holder: Entity | None = field(None)
    caller: Entity | None = field(None)


def bark(ctx, speaker: Entity | None, trigger: str, chance: float = 1.0) -> None:
    if speaker is not None and random.random() < chance:
        ctx.emit(BarkRequested(speaker=speaker, trigger=trigger))


@system("crew_barks", when=playing)
class CrewBarks(System):

    @on(BucketScored)
    def scored(self, ctx, event):
        team = team_of(event.shooter)
        bark(ctx, voice_of(ctx, team, event.shooter), "cheer")
        if team is not Home:
            bark(ctx, voice_of(ctx, Home), "shake_off", chance=0.6)

    @on(BallStolen)
    def stolen(self, ctx, event):
        bark(ctx, voice_of(ctx, team_of(event.by), event.by), "steal")

    @on(ShotMissed)
    def missed(self, ctx, event):
        ours = team_of(event.shooter) is Home
        bark(ctx, voice_of(ctx, Home), "own_miss" if ours else "brick", chance=0.6 if ours else 0.7)

    def update(self, ctx, dt):
        """A bot whose teammate has the ball and no defender within contest range calls
        for it, once per carrier."""
        _, ball = ctx.world.query(Ball).single()
        holder = ball.holder
        call = ctx.get(OpenCall)
        if holder is None:
            call.holder = call.caller = None
            return
        reach = ctx.config(CourtRules).contest_range
        team = team_of(holder)
        open_mates = [mate for mate in ctx.world.query(tagged=team).entities()
                      if mate != holder and not mate.has(You) and nearest_opponent_distance(ctx, mate) > reach]
        if not open_mates:
            call.holder = call.caller = None
            return
        if (call.holder, call.caller) != (holder, open_mates[0]):
            call.holder, call.caller = holder, open_mates[0]
            bark(ctx, open_mates[0], "open")
