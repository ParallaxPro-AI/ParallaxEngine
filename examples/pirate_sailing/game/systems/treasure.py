import random

from parallax import System, Vec2, Vec3, system
from project import Assets, Prefabs

from game.components import CrewShip, TreasureChest
from game.config import Deed, Sounds, VoyageRules
from game.content import Stat
from game.resources import Voyage
from game.rules import current_leg, refit, sailing
from game.standing import hoard_scale, record_deed


@system("treasure", when=sailing)
class Treasure(System):
    """Floating chests. The sea is topped back up when it runs low, and any captain who
    sails over one scoops it into the shared purse — and onto their own tally."""

    def update(self, ctx, dt):
        leg = current_leg(ctx)
        floating = ctx.world.query(tagged=TreasureChest).count()
        if floating < leg.treasure_count * 0.6:
            for _ in range(leg.treasure_count - floating):
                ctx.world.spawn(Prefabs.treasure_chest, at=self.open_water(ctx))
        reach = ctx.config(VoyageRules).pickup_radius + refit(ctx, Stat.PICKUP_RADIUS)
        for ship in ctx.world.query(tagged=CrewShip):
            for chest in ctx.world.query(tagged=TreasureChest).near(ship.transform.position, reach):
                self.scoop(ctx, ship, chest)

    def open_water(self, ctx):
        """A random spot in the treasure field, clear of the harbour berths."""
        rules = ctx.config(VoyageRules)
        while True:
            spot = Vec2(random.uniform(-1, 1), random.uniform(-1, 1)) * rules.treasure_radius
            if spot.length() >= rules.harbour_radius:
                return Vec3(spot.x, 0.45, spot.y)

    def scoop(self, ctx, ship, chest):
        gold = round(current_leg(ctx).treasure_value * hoard_scale(ctx, refit(ctx, Stat.TREASURE_BONUS)))
        voyage = ctx.get(Voyage)
        voyage.purse += gold
        voyage.leg_gold += gold
        captain = ship.owner.id
        voyage.plunder[captain] = voyage.plunder.get(captain, 0) + gold
        at = chest.transform.position
        ctx.audio.play(ctx.config(Sounds).treasure, at=at)
        ctx.vfx.play(Assets.vfx.gold_sparkle, at=Vec3(at.x, 0.9, at.z))
        ctx.ui.float_text(f"+{gold}", at)
        chest.destroy()
        record_deed(ctx, Deed.HAUL)
