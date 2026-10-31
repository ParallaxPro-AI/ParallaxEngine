"""Fog of war: which entities the server sends to which player."""

from parallax import Context, Entity, Player

from features.vision.components import Sight, TrueSight
from game.components import Structure
from game.config import MatchRules
from game.resources import playing


def visible(ctx: Context, player: Player, entity: Entity) -> bool:
    """`net(visible=...)`. Outside the live match everything is visible (the draft
    board lists both teams). During it a player receives their own team's units,
    every structure, and any other unit inside the Sight radius of one of their
    team's champions, minions, towers or wards, unless it stands in a brush patch
    that eye is not in (a TrueSight eye — a Watchfire, a Hushbell pulse — sees into brush)."""
    me = player.entity
    if me is None or not playing(ctx) or entity.has(Structure) or not ctx.combat.are_enemies(me, entity):
        return True
    here = entity.transform.position
    eyes = ctx.world.query(Sight).near(here, ctx.config(MatchRules).max_sight)
    return any(not ctx.combat.are_enemies(me, eye) and (eye.transform.position - here).length() <= sight.radius
               and (eye.has(TrueSight) or not ctx.terrain.hidden_by_brush(eye.transform.position, here))
               for eye, sight in eyes)
