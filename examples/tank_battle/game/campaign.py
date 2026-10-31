"""Moving through the campaign. These are panel actions; the workshop's auto-pick
calls `roll_on` too."""

from parallax import Context, ContentRef

from game.config import Sounds
from game.content import UpgradeDef
from game.loadout import apply_upgrade
from game.resources import BattleState, Campaign, Career, Loadout, Phase


def new_campaign(ctx: Context) -> None:
    """Start over on the campaign's first battlefield with an empty loadout."""
    career = ctx.get(Career)
    career.furthest, career.build = None, []
    ctx.scenes.load(Campaign().battlefield.data.scene, new_run=True)


def continue_campaign(ctx: Context) -> None:
    """Resume the unfinished campaign at the furthest battlefield, with the build that got there."""
    career = ctx.get(Career)
    if career.furthest is None:
        return
    build = Loadout()
    for pick in career.build:
        apply_upgrade(build, pick)
    # init= takes the constructor's fields (fields set after construction are not applied)
    loadout = Loadout(picks=build.picks, damage=build.damage, max_health=build.max_health, pierce=build.pierce,
                      resist=build.resist, splash_radius=build.splash_radius, splash_damage=build.splash_damage,
                      repair_bonus=build.repair_bonus, extra_ammo=build.extra_ammo, reload_mul=build.reload_mul,
                      speed_mul=build.speed_mul, traverse_mul=build.traverse_mul)
    ctx.scenes.load(career.furthest.data.scene, new_run=True,
                    init=[Campaign(battlefield=career.furthest), loadout])


def roll_on(ctx: Context, upgrade: ContentRef[UpgradeDef]) -> None:
    """Keep the picked card for the rest of the campaign and load the next battlefield."""
    state = ctx.get(BattleState)
    if state.phase is not Phase.WORKSHOP:
        return  # the auto-pick and a click landed in the same frame
    state.phase = Phase.COUNTDOWN
    apply_upgrade(ctx.get(Loadout), upgrade)
    ctx.audio.play(ctx.config(Sounds).rack, volume=0.5)
    campaign = ctx.get(Campaign)
    campaign.battlefield = campaign.battlefield.data.next
    career = ctx.get(Career)
    career.furthest, career.build = campaign.battlefield, list(ctx.get(Loadout).picks)
    ctx.scenes.load(campaign.battlefield.data.scene)
