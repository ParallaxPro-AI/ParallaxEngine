"""The run's flow, shared by the round director, the player's last life and the
upgrade panel. The `UpgradeChoice` and `RunOver` panels follow `Match.phase`."""

from parallax import Context, ContentRef
from parallax.characters import Character

from game.arena import current_round, player, safest_spawn_point, spawn_bot
from game.audio import Sounds, play
from game.components import Plating
from game.config import MatchRules
from game.content import RoundDef, UpgradeDef
from game.resources import Career, CareerBests, FeedKind, FeedLine, Match, Mods, Phase


def feed(ctx: Context, text: str, kind: FeedKind, *, points: int = 0, multiplier: float = 0) -> None:
    """A line in the HUD's centre feed (it fades after `MatchRules.feed_seconds`)."""
    match = ctx.get(Match)
    match.feed.append(FeedLine(id=match.next_feed, text=text, kind=kind, at=ctx.time.now,
                               points=points, multiplier=multiplier))
    match.next_feed += 1
    match.feed = match.feed[-5:]


def begin_round(ctx: Context, index: int) -> None:
    """Raise the round banner, top up the player's starting plating and field its roster."""
    match = ctx.get(Match)
    match.round, match.frags, match.phase = index, 0, Phase.FIGHTING
    match.banner_at = ctx.time.now
    play(ctx, ctx.config(Sounds).round_start)
    fight = current_round(ctx)
    plating = player(ctx).get(Plating)
    plating.points = max(plating.points, ctx.get(Mods).armor_start)
    names = iter(ctx.config(MatchRules).bot_names)
    for entry in fight.roster:
        for _ in range(entry.count):
            spawn_bot(ctx, entry.bot, next(names))
    # As the template's _start_round: the player starts each round at the spawn point
    # farthest from the fresh roster.
    player(ctx).get(Character).teleport(safest_spawn_point(ctx).transform.position)


def take_upgrade(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> None:
    """Panel action: keep one of the offered cards for the rest of the run, then fight on."""
    card, mods, match = upgrade.data, ctx.get(Mods), ctx.get(Match)
    mods.damage_dealt_mul *= card.damage_dealt_mul
    mods.damage_taken_mul *= card.damage_taken_mul
    mods.bot_accuracy_mul *= card.bot_accuracy_mul
    mods.bot_health_mul *= card.bot_health_mul
    mods.score_mul *= card.score_mul
    mods.bot_respawn_add += card.bot_respawn_add
    mods.armor_start += card.armor_start
    mods.armor_on_kill += card.armor_on_kill
    mods.ammo_on_kill.extend(card.ammo_on_kill)
    mods.streak_step_add += card.streak_step_add
    match.lives += card.lives
    match.lives_max += card.lives
    match.taken.append(upgrade)
    play(ctx, ctx.config(Sounds).upgrade_taken)
    feed(ctx, f"Upgrade: {ctx.text(card.name)}", FeedKind.BUFF)
    begin_round(ctx, match.round + 1)


def end_run(ctx: Context, won: bool) -> None:
    """Victory after the last round, defeat on the last life. The career keeps the totals
    and the best single run; the debrief compares this run with the bests before it."""
    match, career = ctx.get(Match), ctx.get(Career)
    match.phase = Phase.WON if won else Phase.LOST
    match.ended_at = ctx.time.now
    cleared = len(ctx.content(RoundDef)) if won else match.round
    best = career.best
    match.best_before = CareerBests(score=best.score, frags=best.frags, streak=best.streak, rounds=best.rounds)
    career.runs += 1
    career.wins += int(won)
    career.frags += match.run_frags
    career.deaths += match.deaths
    career.shots += match.shots
    career.hits += match.hits
    career.rounds += cleared
    career.best = CareerBests(
        score=max(best.score, match.score), frags=max(best.frags, match.run_frags),
        streak=max(best.streak, match.best_streak), rounds=max(best.rounds, cleared),
    )
    sounds = ctx.config(Sounds)
    play(ctx, sounds.victory if won else sounds.defeat)
