"""Paid services: armour, a repair, the loading permit and a safehouse save."""

from parallax import Context, ContentRef, TextRef
from parallax.combat import Health
from project import Text

from features.driving.feature import CarCondition, player_car
from features.missions.content import ServiceDef, ServiceKind
from features.missions.contracts import active_contract
from features.missions.facts import PermitOwned
from features.missions.resources import Job
from features.on_foot.feature import Armour, Location, Player, Wallet
from features.police.feature import Wanted, wanted_level


def buy_service(ctx: Context, service: ContentRef[ServiceDef]) -> None:
    """The board's service buttons: sells it when the player is in the right place, has no heat, and can
    pay; otherwise the board says why not."""
    job = ctx.get(Job)
    refusal = refusal_for(ctx, service.data)
    if refusal is not None:
        job.notice = refusal
        return
    ctx.get(Wallet).cash -= service.data.price
    kind = service.data.kind
    if kind is ServiceKind.ARMOUR:
        player = ctx.world.query(tagged=Player).single()
        player.get(Health).shield = player.get(Armour).capacity
    elif kind is ServiceKind.REPAIR:
        player_car(ctx).get(CarCondition).damage = 0.0
    elif kind is ServiceKind.PERMIT:
        ctx.story.facts.set(PermitOwned, True)
    else:
        ctx.save.save("auto")
    job.notice = Text.service_done


def refusal_for(ctx: Context, service: ServiceDef) -> TextRef | None:
    """Why the board refuses a service right now, or None if it can go ahead."""
    inside = ctx.get(Location).interior
    if wanted_level(ctx.get(Wanted)) > 0:
        return Text.service_clear_heat
    if inside is None or inside != ctx.world.placement(service.at).loaded:
        return Text.service_wrong_place
    if ctx.get(Wallet).cash < service.price:
        return Text.service_no_cash
    if service.kind is ServiceKind.REPAIR and player_car(ctx) is None:
        return Text.service_bring_car
    if service.kind is ServiceKind.PERMIT and ctx.story.facts.get(PermitOwned):
        return Text.service_owned
    if service.kind is ServiceKind.SAVE and active_contract(ctx) is not None:
        return Text.service_finish_job
    return None
