from parallax import Behavior, ContentRef, Entity, Vec3, behavior, param, state
from parallax.combat import Health, Side

from features.fighting.feature import Attacker, can_fight, distance, nearest_enemy
from features.heroes.feature import AbilityBook, CastRequested, Hero, Mana, Orders, Progression, RankUpRequested, fountain_of
from features.lanes.feature import Minion, WaveClock
from game.content import AbilityKind, FactionDef, LaneDef
from game.resources import playing


@behavior("bot_brain", requires=[Hero, Orders, Attacker, AbilityBook, Mana, Progression, Health], when=playing)
class BotBrain(Behavior):
    """Plays a champion when no person does, by giving the same orders a player
    would, while the match is live. It ranks the ultimate first, walks its lane up
    to the front line, and fights the nearest enemy there with abilities and
    attacks. When low, it goes home to heal until nearly full."""

    lane: ContentRef[LaneDef] = param()
    engage_range: float = param(14, unit="m")
    retreat_below: float = param(0.28, doc="Health fraction that sends the bot home.")
    return_above: float = param(0.9)
    defensive_above: float = param(0.8, doc="Heals and shields wait until health drops below this.")
    rank_order: list[int] = param([3, 0, 1, 2], doc="Slots to rank up, most wanted first.")
    retreating: bool = state(False)

    def update(self, ctx, dt):
        health = self.entity.get(Health)
        if health.dead:
            return
        if self.entity.get(Progression).skill_points:
            for slot in self.rank_order:
                ctx.emit(RankUpRequested(hero=self.entity, slot=slot))
        orders = self.entity.get(Orders)
        attacker = self.entity.get(Attacker)
        self.retreating = health.fraction < (self.return_above if self.retreating else self.retreat_below)
        if self.retreating:
            attacker.target = None
            orders.destination = fountain_of(ctx, self.entity).transform.position
            return
        if not can_fight(ctx, self.entity, attacker.target):
            attacker.target = nearest_enemy(ctx, self.entity, self.engage_range)
        if attacker.target:
            self._cast_at(ctx, attacker.target, health)
        else:
            orders.destination = self._front_line(ctx)

    def _cast_at(self, ctx, target: Entity, health: Health):
        book = self.entity.get(AbilityBook)
        mana = self.entity.get(Mana).current
        for slot, ref in enumerate(book.abilities):
            ability, rank = ref.data, book.ranks[slot]
            if rank == 0 or ctx.time.now < book.ready_at[slot] or mana < ability.mana.at(rank):
                continue
            if ability.kind in (AbilityKind.HEAL, AbilityKind.SHIELD) and health.fraction > self.defensive_above:
                continue
            if ability.kind is AbilityKind.MELEE and distance(self.entity, target) > ability.range.at(rank):
                continue
            ctx.emit(CastRequested(hero=self.entity, slot=slot, aim=target.transform.position))
            return

    def _front_line(self, ctx) -> Vec3:
        """The most advanced allied minion on this lane, or the lane's first tower line. Before
        the first wave a bot waits where it stands, round the base, and walks out with its
        lane's minions (as the template's bots do: the base is full of them at 0:05)."""
        side = self.entity.get(Side).side
        faction = ctx.content(FactionDef).first(lambda f: f.side == side).data
        path = list(reversed(self.lane.data.path)) if faction.walks_lanes_backwards else self.lane.data.path
        enemy_end = path[-1].to_ground()
        allies = (ctx.world.query(Minion)
                  .where(lambda e, minion: minion.lane == self.lane and not ctx.combat.are_enemies(self.entity, e))
                  .entities())
        if not allies:
            return self.entity.transform.position if ctx.get(WaveClock).number == 0 else path[2].to_ground()
        return min(allies, key=lambda e: (e.transform.position - enemy_end).length()).transform.position
