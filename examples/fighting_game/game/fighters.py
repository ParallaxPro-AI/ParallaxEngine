"""Small questions about the two fighters that several modules ask."""

from parallax import ContentRef, Context, Entity, Model, vec3
from parallax.characters import Character
from parallax.combat import Health
from project import Placed

from game.components import Challenger, Corner, Fighter, Intent
from game.content import MoveDef
from game.resources import Career, Preferences
from game.rules import Rules


def opponent_of(ctx: Context, fighter: Entity) -> Entity:
    """The other placed fighter."""
    return ctx.world.placed(Placed.rival if fighter.has(Challenger) else Placed.challenger)


def toward(fighter: Entity, other: Entity) -> int:
    """+1 if `other` stands to the right of `fighter` on the fight line, else -1."""
    return 1 if other.transform.position.x >= fighter.transform.position.x else -1


def corner_of(entity: Entity) -> Corner:
    return Corner.CHALLENGER if entity.has(Challenger) else Corner.RIVAL


def buffer_attack(ctx: Context, intent: Intent, move: ContentRef[MoveDef]) -> None:
    """Queue an attack. It comes out as soon as the fighter can act, or is dropped
    `Rules.buffer_seconds` from now (a deadline, so it keeps across the intro)."""
    intent.attack = move
    intent.attack_expires_at = ctx.time.now + ctx.config(Rules).buffer_seconds


def reset_fighter(entity: Entity, x: float, meter: float) -> None:
    """Fresh fighter state on its starting mark, at full health."""
    entity.add(Fighter(meter=meter))
    entity.add(Intent())
    entity.transform.position = vec3(x, 0, 0)
    entity.get(Character).stop()
    entity.get(Health).revive()


def dress_challenger(ctx: Context) -> None:
    """Your fighter wears the bone kit, or the amber champion kit once a belt is won and
    the moves panel's "Wear champion kit" is on."""
    champion = ctx.get(Career).belts > 0 and ctx.get(Preferences).champion_kit
    ctx.world.placed(Placed.challenger).get(Model).set_option("kit", "amber" if champion else "bone")
