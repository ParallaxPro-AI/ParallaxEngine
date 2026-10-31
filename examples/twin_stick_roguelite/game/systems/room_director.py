import random

from parallax import System, Vec2, on, system
from parallax.cinematics import CinematicMarker
from project import Assets, Content, Placed, Prefabs, Scenes, Text

from game.components import Foe, Room
from game.content import Elites
from game.events import FloorBossCleared, RunWon, SummonRequested
from game.foes import spawn_foe
from game.loot import drop_loot
from game.resources import Run
from game.rooms import lay_cover, room_at
from game.rules import Rules, Sounds, current_floor, is_last_floor


@system("room_director", scenes=[Scenes.cellar])
class RoomDirector(System):
    """Rooms come alive when the keeper is well inside them: a tile-solved cover layout
    rises, the squad spawns on its open cells (a lone boss in the centre, with its intro
    cutscene), and the gates shut (they read `Room.fighting`). When the last foe in the
    room dies, the room pays out and the gates sink again."""

    def update(self, ctx, dt):
        keeper_at = ctx.world.placed(Placed.keeper).transform.position
        inside = room_at(ctx, keeper_at)
        if inside:
            inside[1].visited = True
        deep = room_at(ctx, keeper_at, margin=ctx.config(Rules).enter_margin)
        if deep:
            entity, room = deep
            if room.kind.data.fights and not room.cleared and not room.fighting:
                self.engage(ctx, entity, room, keeper_at)
        for entity, room in ctx.world.query(Room):
            if room.fighting and not ctx.world.query(Foe).where(lambda _, foe: foe.room == entity).count():
                self.clear(ctx, entity, room)

    def engage(self, ctx, room_entity, room, keeper_at):
        rules = ctx.config(Rules)
        kind = room.kind.data
        floor = current_floor(ctx)
        room.fighting = True
        center = room_entity.transform.position
        squad = floor.squads.get(room.kind, {})
        total = sum([count for count in squad.values()])
        spots = lay_cover(ctx, rules, center, keeper_at, total + rules.breakables_per_room)
        for i in range(rules.breakables_per_room):
            ctx.world.spawn(rules.breakables[i % len(rules.breakables)], at=spots.pop())
        for enemy, count in squad.items():
            for _ in range(count):
                elite = kind.elites is Elites.ALWAYS or (
                    kind.elites is Elites.SOMETIMES and random.random() < floor.elite_chance)
                at = center if total == 1 else spots.pop()
                foe = spawn_foe(ctx, enemy, at, room_entity, elite=elite)
                if enemy.data.boss:
                    ctx.cinematics.play(Content.cinematic.boss_intro, bind={"boss": foe})
                    ctx.ui.announce(Text.boss_wakes, enemy.data.name, seconds=2.3)
        if kind.engage_text:
            ctx.ui.toast(kind.engage_text)
        if kind.engage_sound:
            ctx.audio.play(kind.engage_sound)

    def clear(self, ctx, room_entity, room):
        room.fighting = False
        room.cleared = True
        at = room_entity.transform.position
        if room.kind.data.clear_reward:
            drop_loot(ctx, room.kind.data.clear_reward, at)
        if room.kind != Content.room.boss:
            ctx.audio.play(ctx.config(Sounds).room_clear)
            return
        if is_last_floor(ctx):
            ctx.emit(RunWon())
            return
        ctx.world.spawn(Prefabs.exit_pad, at=at)
        ctx.vfx.play(Assets.vfx.exit_sparkle, at=at.with_y(0.6))
        ctx.ui.toast(Text.way_down_opens)
        ctx.audio.play(ctx.config(Sounds).descend)
        ctx.emit(FloorBossCleared(floor=ctx.get(Run).floor))

    @on(CinematicMarker, where=lambda event: event.name == "reveal" and not event.skipped)
    def boss_revealed(self, ctx, event: CinematicMarker):
        ctx.camera.main.shake(0.55, 0.6)

    @on(SummonRequested)
    def summoned(self, ctx, event: SummonRequested):
        """A boss's brood: real room enemies, capped, and they die with their master."""
        rules = ctx.config(Rules)
        master = event.master.get(Foe)
        alive = ctx.world.query(Foe).where(lambda _, foe: foe.master == event.master).count()
        count = min(event.count, rules.max_adds - alive)
        center = event.master.transform.position
        for i in range(count):
            ring = Vec2.from_angle(360 * i / count, rules.summon_radius).to_ground()
            spawn_foe(ctx, master.kind.data.summon, center + ring, master.room, master=event.master)
            ctx.vfx.play(Assets.vfx.summon, at=(center + ring).with_y(0.8))
        if count > 0:
            ctx.ui.toast(Text.brood_answers)
