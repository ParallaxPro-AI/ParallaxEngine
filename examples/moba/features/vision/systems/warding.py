from parallax import System, on, system
from parallax.combat import Side
from project import Prefabs, Text

from features.heroes.feature import WardRequested
from features.vision.components import Ward, WardKit
from game.config import MatchRules
from game.resources import playing


@system("warding", when=playing)
class Warding(System):
    """The template's ward kit. A Picket (T) is free and recharging: two charges, one back
    every `ward_recharge` seconds, each ward fading after `ward_seconds`. A Watchfire (5) is
    permanent and sees into brush, one per champion. The Hushbell (6) rings true sight over
    a circle for a few seconds on a cooldown, and breaks the enemy wards caught in it."""

    @on(WardRequested, when=playing)
    def place(self, ctx, event: WardRequested):
        rules = ctx.config(MatchRules)
        hero = event.hero
        kit = hero.get(WardKit)
        side = hero.get(Side).side
        reach = {"picket": rules.ward_range, "watchfire": rules.watchfire_range, "hushbell": rules.hushbell_range}[event.kind]
        if (event.at - hero.transform.position).flat().length() > reach:
            ctx.ui.toast(Text.ward_too_far, to=hero.owner)
            return
        if event.kind == "hushbell":
            if ctx.time.now < kit.hush_at:
                ctx.ui.toast(Text.hushbell_cooling, to=hero.owner)
                return
            kit.hush_at = ctx.time.now + rules.hushbell_cooldown
            pulse = ctx.world.spawn(Prefabs.hushbell_pulse, at=event.at, components=[Side(side=side)])
            pulse.destroy(after=rules.hushbell_seconds)
            for ward, mark, ward_side in ctx.world.query(Ward, Side).near(event.at, rules.hushbell_radius):
                if ward_side.side != side:
                    ward.destroy()
            return
        if event.kind == "watchfire":
            if kit.watchfires == 0:
                ctx.ui.toast(Text.no_watchfires, to=hero.owner)
                return
            kit.watchfires -= 1
            ctx.world.spawn(Prefabs.watchfire, at=event.at, components=[Side(side=side), Ward(owner=hero)])
            return
        if kit.charges == 0:
            ctx.ui.toast(Text.no_wards, to=hero.owner)
            return
        if kit.charges == rules.ward_charges:
            kit.charge_at = ctx.time.now + rules.ward_recharge
        kit.charges -= 1
        ward = ctx.world.spawn(Prefabs.ward, at=event.at, components=[Side(side=side), Ward(owner=hero)])
        ward.destroy(after=rules.ward_seconds)

    def update(self, ctx, dt):
        rules = ctx.config(MatchRules)
        for _, kit in ctx.world.query(WardKit):
            if kit.charges < rules.ward_charges and ctx.time.now >= kit.charge_at:
                kit.charges += 1
                kit.charge_at = ctx.time.now + rules.ward_recharge
