from parallax import SceneLoaded, System, on, system
from parallax.combat import Side
from parallax.hud import MapIcon
from parallax.net import PlayerJoined

from game.config import MatchRules
from game.content import FactionDef
from game.resources import Match, Phase


@system("lobby")
class Lobby(System):
    """Seats players as they join. The net plugin has already spawned their hero at
    their seat's PlayerStart (at a fountain); this gives it that seat's side, which
    also decides how its health bar looks to each viewer, and its minimap arrow. Every join opens or
    restarts the draft clock. Players already in the game when the arena loads (the host,
    who left the title with Training with Bots or Custom Match) are seated on the load."""

    @on(PlayerJoined)
    def joined(self, ctx, event: PlayerJoined):
        self._seat(ctx, event.player)

    @on(SceneLoaded)
    def loaded(self, ctx, event: SceneLoaded):
        for player in ctx.players:
            if player.entity is not None and not player.entity.has(Side):
                self._seat(ctx, player)

    def _seat(self, ctx, player):
        faction = ctx.content(FactionDef)[player.index].data
        player.entity.add(Side(side=faction.side))
        player.entity.add(MapIcon(icon="arrow", color=faction.map_color, size=1.8, rotate=True))
        match = ctx.get(Match)
        match.phase = Phase.DRAFT
        match.draft_ends_at = ctx.time.now + ctx.config(MatchRules).draft_seconds
