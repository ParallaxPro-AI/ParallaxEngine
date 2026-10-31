"""Frags, streaks, score and accuracy."""

from parallax import System, on, system
from parallax.combat import Died
from project import Scenes

from game.arena import give_ammo, give_armor, player
from game.audio import Sounds, play
from game.components import Arsenal, Bot, Fighter, Player
from game.config import MatchRules
from game.events import FragScored, ShotFired
from game.resources import FeedKind, Match, Mods
from game.run import feed


@system("scoring", scenes=[Scenes.arena])
class Scoring(System):
    """A frag of yours grows your streak, and each frag in a streak is worth more (up to a
    cap). Every frag and each streak tier goes on the HUD's centre feed. Kill upgrades
    (armor, ammo) pay out here. Dying resets the streak."""

    @on(Died, where=lambda event: event.entity.has(Fighter))
    def frag(self, ctx, event):
        victim = event.entity.get(Fighter)
        killer = event.source.try_get(Fighter) if event.source is not None and event.source.alive else None
        match = ctx.get(Match)
        if event.entity.has(Player):
            match.streak = 0
        if event.entity.has(Bot):
            sounds = ctx.config(Sounds)
            play(ctx, sounds.elite_death if event.entity.get(Bot).kind.data.elite else sounds.bot_death,
                 at=event.entity.transform.position)
        if killer is None:
            return
        if event.source.has(Player) and event.entity.has(Bot):
            self.reward(ctx, match, event.entity.get(Bot))
        ctx.emit(FragScored(killer=killer.name, victim=victim.name, streak=match.streak if event.source.has(Player) else 0))

    def reward(self, ctx, match, bot):
        rules, mods = ctx.config(MatchRules), ctx.get(Mods)
        archetype = bot.kind.data
        match.streak += 1
        match.best_streak = max(match.best_streak, match.streak)
        multiplier = min(rules.streak_max, 1 + (rules.streak_step + mods.streak_step_add) * (match.streak - 1))
        points = round(archetype.score * multiplier * mods.score_mul)
        match.score += points
        name = ctx.text(archetype.name)
        if archetype.elite:
            feed(ctx, f"{name} falls", FeedKind.ELITE, points=points)
        else:
            feed(ctx, f"{name} down", FeedKind.KILL, points=points)
        for tier in rules.streak_tiers:
            if tier.at == match.streak:
                feed(ctx, ctx.text(tier.shout), FeedKind.STREAK, multiplier=round(multiplier * 10) / 10)
        you = player(ctx)
        give_armor(ctx, you, mods.armor_on_kill)
        give_ammo(you.get(Arsenal), mods.ammo_on_kill)

    @on(ShotFired, where=lambda event: event.shooter.has(Player))
    def accuracy(self, ctx, event):
        match = ctx.get(Match)
        match.shots += 1
        match.hits += int(event.hit is not None)
