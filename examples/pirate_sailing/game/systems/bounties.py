from parallax import System, Vec3, on, system
from parallax.combat import Died
from project import Assets

from game.components import Bounty, Ghost, Kraken, Shark
from game.config import Deed, Sounds
from game.content import Stat
from game.resources import Voyage
from game.rules import current_leg, refit
from game.standing import bounty_scale, record_deed


@system("bounties")
class Bounties(System):
    """Every enemy hull pays its bounty into the purse when it goes down, credited to
    the captain who fired the last shot. Hulls of the leg's bounty kind also count
    towards clearing the leg. Bounties scale with Letter of Marque and the Crown's regard,
    and every kill moves the powers of the sea."""

    @on(Died, where=lambda event: event.entity.has(Bounty))
    def pay_bounty(self, ctx, event):
        voyage = ctx.get(Voyage)
        gold = round(event.entity.get(Bounty).gold * bounty_scale(ctx, refit(ctx, Stat.BOUNTY_BONUS)))
        voyage.purse += gold
        voyage.leg_gold += gold
        if event.entity.has(current_leg(ctx).bounty_tag):
            voyage.bounty += 1
        if event.source is not None and event.source.owner is not None:
            captain = event.source.owner.id
            voyage.plunder[captain] = voyage.plunder.get(captain, 0) + gold
        for kind, deed in ((Ghost, Deed.KILL_GHOST), (Kraken, Deed.KILL_KRAKEN), (Shark, Deed.KILL_SHARK)):
            if event.entity.has(kind):
                record_deed(ctx, deed)
                break
        ctx.audio.play(ctx.config(Sounds).ship_sank, at=event.entity)
        ctx.audio.play(ctx.config(Sounds).bounty, volume=0.4)
        if event.entity.has(Ghost):
            ctx.vfx.play(Assets.vfx.sinking_smoke, at=event.entity.transform.position + Vec3(0, 0.8, 0))
        else:
            ctx.vfx.play(Assets.vfx.big_splash, at=event.entity.transform.position + Vec3(0, 0.5, 0), count=95)
