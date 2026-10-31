from parallax import Player, System, on, system
from parallax.combat import Died, Health
from parallax.net import PlayerJoined
from parallax.vehicles import Vehicle
from project import Text

from game.components import Broadsides, CrewShip
from game.config import Deed, Sounds, VoyageRules
from game.content import Stat
from game.events import LegStarted, VoyageEnded
from game.resources import Voyage
from game.rules import crew_left, refit, sailing
from game.standing import record_deed


@system("fleet")
class Fleet(System):
    """The captains' ships. Everyone is launched from their own berth (a PlayerStart)
    when a leg's clock starts, fitted with the whole refit build as stat modifiers; a
    captain who joins mid-leg is launched at once. A sunk ship spends one crew from the
    shared pool and its captain is relaunched after a pause; when the pool is empty the
    voyage is lost."""

    @on(LegStarted)
    def launch_everyone(self, ctx, event):
        for player in ctx.players:
            self.launch(ctx, player)

    @on(PlayerJoined, when=sailing)
    def launch_newcomer(self, ctx, event):
        self.launch(ctx, event.player)

    @on(Died, where=lambda event: event.entity.has(CrewShip))
    def ship_sunk(self, ctx, event):
        ctx.audio.play(ctx.config(Sounds).ship_sank, at=event.entity)
        ctx.get(Voyage).sinkings += 1
        record_deed(ctx, Deed.SHIP_SUNK)
        ctx.audio.play(ctx.config(Sounds).crew_lost)
        if crew_left(ctx) <= 0:
            ctx.emit(VoyageEnded(won=False))
            return
        captain = event.entity.owner
        delay = ctx.config(VoyageRules).respawn_delay
        ctx.ui.announce(Text.ship_lost, ctx.text(Text.crew_left_banner, crew=crew_left(ctx)), seconds=3)
        ctx.ui.toast(ctx.text(Text.you_were_sunk, seconds=round(delay)), to=captain)
        ctx.time.after(delay, lambda: self.relaunch(ctx, captain))

    def relaunch(self, ctx, captain: Player):
        if sailing(ctx) and captain in ctx.players:
            self.launch(ctx, captain)

    def launch(self, ctx, player: Player):
        """A fresh hull from the prefab, with the build stacked on its base stats."""
        ship = ctx.net.respawn(player)
        hull = ship.get(Health)
        armor_room = ctx.config(VoyageRules).max_armor - hull.armor
        ship.modify(Health, "max", add=refit(ctx, Stat.MAX_HULL), key="refit")
        ship.modify(Health, "armor", add=min(armor_room, refit(ctx, Stat.ARMOR)), key="refit")
        ship.modify(Vehicle, "max_speed", add=refit(ctx, Stat.MAX_SPEED), key="refit")
        ship.modify(Broadsides, "rack", add=refit(ctx, Stat.BROADSIDE), key="refit")
        hull.current = hull.max
