"""The run: five escalating rounds, each to a frag target, with an upgrade between them."""

import random

from parallax import SceneLoaded, System, on, system
from parallax.combat import Died
from project import Scenes, Text

from game.arena import current_round, fighting, player, spawn_bot
from game.audio import Sounds, play
from game.components import Bot, Fighter
from game.config import MatchRules
from game.content import RoundDef, UpgradeDef
from game.events import FragScored
from game.resources import Match, Mods, PendingBot, Phase
from game.run import begin_round, end_run


@system("rounds", scenes=[Scenes.arena])
class Rounds(System):
    """Fields each round's roster of bots, brings fragged bots back after a delay, and
    clears the round when the player reaches its frag target. Then it deals upgrade
    cards (the `UpgradeChoice` panel keeps one and starts the next round) or, after
    the last round, ends the run in victory."""

    @on(SceneLoaded)
    def start_run(self, ctx, event):
        match = ctx.get(Match)
        match.lives = match.lives_max = ctx.config(MatchRules).lives
        match.started_at = ctx.time.now
        player(ctx).get(Fighter).name = ctx.text(Text.you)
        begin_round(ctx, 0)

    def update(self, ctx, dt):
        match = ctx.get(Match)
        for pending in [p for p in match.bot_respawns if p.at <= ctx.time.now]:
            match.bot_respawns.remove(pending)
            spawn_bot(ctx, pending.bot, pending.name)

    @on(Died, when=fighting, where=lambda event: event.entity.has(Bot))
    def bot_down(self, ctx, event):
        delay = ctx.config(MatchRules).bot_respawn_delay + ctx.get(Mods).bot_respawn_add
        ctx.get(Match).bot_respawns.append(
            PendingBot(bot=event.entity.get(Bot).kind, name=event.entity.get(Fighter).name, at=ctx.time.now + delay)
        )

    @on(FragScored, when=fighting)
    def count_frag(self, ctx, event):
        match = ctx.get(Match)
        if event.killer != player(ctx).get(Fighter).name:
            return
        match.frags += 1
        match.run_frags += 1
        if match.frags >= current_round(ctx).frag_target:
            self.clear_round(ctx, match)

    def clear_round(self, ctx, match):
        match.bot_respawns.clear()
        for bot in ctx.world.query(Bot).entities():
            bot.destroy()
        play(ctx, ctx.config(Sounds).round_clear)
        if match.round == len(ctx.content(RoundDef)) - 1:
            end_run(ctx, won=True)
            return
        deck = ctx.content(UpgradeDef)
        match.offer = random.sample(list(deck), min(ctx.config(MatchRules).upgrade_draw, len(deck)))
        match.phase = Phase.INTERMISSION
