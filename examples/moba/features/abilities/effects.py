"""What each kind of ability does. One function per AbilityKind; every number
comes from the ability's data at the rank it was cast at. Damage goes through the
combat plugin, so shields, armor and the core's guard apply on their own."""

from parallax import Context, Entity, Task, Vec3, vec3
from parallax.combat import Health, StatusEffects

from features.fighting.feature import Stats, add_stats, enemies_near
from game.components import Physical
from game.content import AbilityDef, AbilityKind
from game.physics import Layers

CLEAVE_COS = 0.5
"""cos(60°): a melee ability hits a 120° arc in front of the caster."""

CAST_HEIGHT = vec3(0, 1.1, 0)
"""Where a cast effect plays above the caster's feet."""
HIT_HEIGHT = vec3(0, 1.0, 0)
"""Where an impact plays above a hit unit's (or a landed dash's) feet."""


def cast_ability(ctx: Context, caster: Entity, ability: AbilityDef, rank: int, aim: Vec3) -> None:
    EFFECTS[ability.kind](ctx, caster, ability, rank, aim)


def melee(ctx, caster, ability, rank, aim):
    here = caster.transform.position
    _cast(ctx, caster, ability)
    facing = (aim - here).flat().normalized()
    in_arc = [e for e in enemies_near(ctx, caster, here, ability.range.at(rank))
              if facing.dot((e.transform.position - here).flat().normalized()) >= CLEAVE_COS]
    _strike(ctx, caster, ability, rank, in_arc)


def skillshot(ctx, caster, ability, rank, aim):
    """Everything within width/2 of the line, out to range, is hit. A player's line is
    tested against where their screen showed each enemy when they cast (lag
    compensation); a bot's against where enemies are."""
    here = caster.transform.position
    direction = (aim - here).flat().normalized()
    reach = ability.range.at(rank)
    player = caster.owner

    def seen(enemy: Entity) -> Vec3:
        return ctx.net.seen_position(enemy, player) if player else enemy.transform.position

    def on_line(enemy: Entity) -> bool:
        offset = (seen(enemy) - here).flat()
        along = offset.dot(direction)
        return 0 <= along <= reach and (offset - direction * along).length() <= ability.width / 2

    _cast(ctx, caster, ability)
    _strike(ctx, caster, ability, rank, [e for e in enemies_near(ctx, caster, here, reach + ability.width) if on_line(e)])


def ground(ctx, caster, ability, rank, aim):
    here = caster.transform.position
    toward = (aim - here).flat()
    reach = ability.range.at(rank)
    center = here + (toward.normalized() * reach if toward.length() > reach else toward)
    radius = ability.radius.at(rank)
    _cast(ctx, caster, ability)
    _burst(ctx, caster, ability, rank, center, radius)


def heal(ctx, caster, ability, rank, aim):
    caster.get(Health).heal(ability.heal.at(rank))
    ctx.vfx.play(ability.vfx, at=caster)


def shield(ctx, caster, ability, rank, aim):
    caster.get(Health).add_shield(ability.shield.at(rank), seconds=ability.duration.at(rank))
    ctx.vfx.play(ability.vfx, at=caster)


def buff(ctx, caster, ability, rank, aim):
    add_stats(caster, ability.buff, key="ability_buff", seconds=ability.duration.at(rank))
    _cast(ctx, caster, ability)
    ctx.vfx.play(ability.vfx, at=caster)


def dash(ctx, caster, ability, rank, aim):
    """Dash toward the aim (or away from it), stopping short of terrain. A dash
    that deals damage detonates where it lands."""
    here = caster.transform.position
    direction = (aim - here).flat().normalized() * (-1 if ability.dash_away else 1)
    length = ability.dash.at(rank) + caster.get(Stats).dash_bonus
    wall = ctx.physics.raycast(here + vec3(0, 1, 0), direction, length, layers=[Layers.terrain])
    landing = here + direction * (max(0.0, wall.distance - 0.5) if wall else length)

    trail = ctx.vfx.trail(caster, color=ability.trail, seconds=0.34, glow=True) if ability.trail else None

    async def travel(ctx: Context, task: Task):
        await caster.transform.move_to(landing, ability.dash_seconds, ease="out_quad").wait()
        if trail is not None:
            ctx.time.after(0.34, trail.cancel)
        if ability.damage.base:
            _burst(ctx, caster, ability, rank, landing, ability.radius.at(rank), show_hits=False)
        # The landing effect, tinted like the trail when the ability has one.
        ctx.vfx.play(ability.vfx, at=caster.transform.position + HIT_HEIGHT, color=ability.trail)

    ctx.run(travel)


def _cast(ctx, caster: Entity, ability: AbilityDef) -> None:
    if ability.cast_vfx:
        ctx.vfx.play(ability.cast_vfx, at=caster.transform.position + CAST_HEIGHT)


def _amount(caster: Entity, ability: AbilityDef, rank: int) -> float:
    return ability.damage.at(rank) + caster.get(Stats).ability_power


def _strike(ctx, caster: Entity, ability: AbilityDef, rank: int, targets: list[Entity]) -> None:
    """Hit exactly these units (shapes the combat plugin can't query: arcs, lines)."""
    amount = _amount(caster, ability, rank)
    for target in targets:
        target.get(Health).damage(amount, source=caster, kind=ability.damage_kind or Physical)
    _afflict(ctx, caster, ability, targets)


def _burst(ctx, caster: Entity, ability: AbilityDef, rank: int, center: Vec3, radius: float,
           show_hits: bool = True) -> None:
    """Hit every enemy in a circle."""
    hit = ctx.combat.area_damage(center, radius, _amount(caster, ability, rank), source=caster,
                                 kind=ability.damage_kind or Physical, falloff=False)
    _afflict(ctx, caster, ability, hit, show_hits)


def _afflict(ctx, caster: Entity, ability: AbilityDef, targets: list[Entity], show_hits: bool = True) -> None:
    """The ability's status effect (a slow) and its impact effect on everyone it hit."""
    for target in targets:
        effects = target.try_get(StatusEffects)
        if ability.effect and effects:
            effects.apply(ability.effect, ability.effect_seconds, source=caster)
        if show_hits:
            ctx.vfx.play(ability.vfx, at=target.transform.position + HIT_HEIGHT)


EFFECTS = {
    AbilityKind.MELEE: melee,
    AbilityKind.SKILLSHOT: skillshot,
    AbilityKind.GROUND: ground,
    AbilityKind.HEAL: heal,
    AbilityKind.SHIELD: shield,
    AbilityKind.BUFF: buff,
    AbilityKind.DASH: dash,
}
