"""Spawning enemies scaled for the current floor, optionally promoted to an elite."""

from parallax import Context, ContentRef, Entity, Model, Vec3
from parallax.combat import Health

from game.components import Foe
from game.content import EnemyDef
from game.rules import Rules, current_floor


def spawn_foe(ctx: Context, enemy: ContentRef[EnemyDef], at: Vec3, room: Entity,
              *, elite: bool = False, master: Entity | None = None) -> Entity:
    rules = ctx.config(Rules)
    data = enemy.data
    floor = current_floor(ctx)
    hp = data.hp * (floor.boss_hp_mult if data.boss else floor.enemy_hp_mult)
    damage = data.contact_damage
    if elite:
        hp *= rules.elite_hp_mult
        damage += rules.elite_damage_bonus
    hp = round(hp)
    foe = ctx.world.spawn(data.prefab, at=at, components=[
        Health(current=hp, max=hp),
        Foe(kind=enemy, room=room, contact_damage=damage, elite=elite, master=master),
    ])
    if elite:
        foe.transform.scale = foe.transform.scale * rules.elite_scale
        foe.get(Model).tint = rules.elite_tint
    return foe
