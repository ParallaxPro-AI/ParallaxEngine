from parallax import Entity, System, Tag, on, system
from parallax.combat import Died, Health, Side
from parallax.net import PlayerLeft
from project import Text

from features.heroes.feature import Hero
from features.match.resources import Record
from game.components import Blue, Core, Tower
from game.audio import Sounds, play
from game.config import MatchRules
from game.content import FactionDef
from game.resources import Match, Phase, announce, log_kill, playing


def _label(ctx, entity: Entity | None) -> str:
    """How the kill feed names a unit."""
    if entity is None:
        return ""
    if entity.has(Hero):
        return ctx.text(entity.get(Hero).champion.data.name)
    if entity.has(Tower):
        return ctx.text(Text.feed_tower)
    if entity.has(Core):
        return ctx.text(Text.feed_core)
    return ctx.text(Text.feed_minion)


@system("victory")
class Victory(System):
    """Ends the live match: a team wins when the enemy core falls, or when an enemy
    player leaves (a forfeit). Each player's profile record is updated on the server."""

    @on(Died, when=playing, where=lambda event: event.entity.has(Core))
    def core_fell(self, ctx, event: Died):
        loser = event.entity.get(Side).side
        killer = event.source
        log_kill(ctx, _label(ctx, killer), _label(ctx, event.entity), killer.get(Side).side if killer else None, loser)
        self._end(ctx, loser=loser)

    @on(Died, when=playing, where=lambda event: event.entity.has(Tower))
    def tower_fell(self, ctx, event: Died):
        """Counts the tower for the other team, logs it, and announces a core whose
        base towers are now all down (its shield is gone)."""
        match = ctx.get(Match)
        tower = event.entity
        side = tower.get(Side).side
        if side == Blue:
            match.red_towers += 1
        else:
            match.blue_towers += 1
        killer = event.source
        log_kill(ctx, _label(ctx, killer), _label(ctx, tower), killer.get(Side).side if killer else None, side)
        core = ctx.world.query(tagged=Core).where(lambda c: c.get(Side).side == side).first()
        if core is None:
            return
        radius = ctx.config(MatchRules).core_guard_radius
        guards = [t for t in ctx.world.query(tagged=Tower).near(core.transform.position, radius)
                  if t != tower and not t.get(Health).dead and t.get(Side).side == side]
        exposed = not guards
        if exposed and not (match.blue_core_exposed if side == Blue else match.red_core_exposed):
            if side == Blue:
                match.blue_core_exposed = True
            else:
                match.red_core_exposed = True
            enemy = ctx.content(FactionDef).first(lambda f: f.side != side).data.side
            announce(ctx, ctx.text(Text.core_exposed, faction=ctx.text(self._faction(ctx, side))), "kill", side=enemy)
            play(ctx, ctx.config(Sounds).vo_objective)

    @on(PlayerLeft, when=playing)
    def forfeited(self, ctx, event: PlayerLeft):
        self._end(ctx, loser=event.player.entity.get(Side).side)

    def _end(self, ctx, loser: Tag):
        match = ctx.get(Match)
        match.winner = ctx.content(FactionDef).first(lambda f: f.side != loser).data.side
        match.phase = Phase.ENDED
        match.ended_at = ctx.time.now
        for player in ctx.players:
            # PROPOSED: `ctx.get(R, player=)` for a profile resource on the server (NOTES.md).
            record = ctx.get(Record, player=player)
            if player.entity.get(Side).side == match.winner:
                record.wins += 1
            else:
                record.losses += 1

    def _faction(self, ctx, side: Tag):
        return ctx.content(FactionDef).first(lambda f: f.side == side).data.name
