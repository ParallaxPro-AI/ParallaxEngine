from parallax import ContentRef, System, system
from parallax.combat import Side

from features.economy.feature import Bounty
from features.fighting.feature import Animations, Attacker, set_base
from features.lanes.components import Minion
from features.lanes.resources import WaveClock
from game.audio import Sounds, play
from game.config import MatchRules
from game.content import FactionDef, LaneDef, StatBlock, UnitDef
from game.resources import playing


@system("lane_waves", when=playing)
class LaneWaves(System):
    """Every `wave_interval` seconds each faction sends a wave down every lane in
    formation: melee in front, casters behind. The mix grows with the wave number
    (siege units from wave 3, juggernauts from 8), and so do minion health and
    damage, up to a cap."""

    def update(self, ctx, dt):
        clock = ctx.get(WaveClock)
        clock.next_in -= dt
        if clock.next_in > 0:
            return
        rules = ctx.config(MatchRules)
        clock.number += 1
        clock.next_in = rules.wave_interval
        units = [mix for mix in rules.wave_mix if mix.from_wave <= clock.number][-1].units
        for faction in ctx.content(FactionDef):
            for lane in ctx.content(LaneDef):
                self._send(ctx, faction.data, lane, units, clock.number)

    def _send(self, ctx, faction: FactionDef, lane: ContentRef[LaneDef], units: list[ContentRef[UnitDef]], wave: int):
        rules = ctx.config(MatchRules)
        path = list(reversed(lane.data.path)) if faction.walks_lanes_backwards else lane.data.path
        forward = (path[1] - path[0]).normalized()
        across = forward.rotated(90)
        in_row: dict[int, int] = {}
        for unit in units:
            row = unit.data.rank
            column = in_row.get(row, 0)
            in_row[row] = column + 1
            spot = path[0] - forward * (row * rules.formation_depth) + across * ((column - 1) * rules.formation_spacing)
            minion = ctx.world.spawn(faction.minion, at=spot.to_ground(), scale=unit.data.scale, components=[
                Side(side=faction.side),
                Minion(unit=unit, lane=lane, backwards=faction.walks_lanes_backwards),
                Attacker(bolt=unit.data.bolt),
                Animations(clips=unit.data.clips),
                Bounty(gold=unit.data.gold, xp=unit.data.xp),
            ])
            set_base(minion, _grown(ctx, unit.data, wave))
        play(ctx, ctx.config(Sounds).wave_spawn, path[0].to_ground())


def _grown(ctx, unit: UnitDef, wave: int) -> StatBlock:
    """The unit's stats, strengthened by how late in the match this wave is."""
    rules = ctx.config(MatchRules)
    health = min(rules.max_growth, 1 + rules.health_growth * (wave - 1))
    damage = min(rules.max_growth, 1 + rules.damage_growth * (wave - 1))
    return unit.stats + StatBlock(max_health=unit.stats.max_health * (health - 1),
                                  damage=unit.stats.damage * (damage - 1))
