"""Headless playtests (fixed seed, fixed timestep)."""

from parallax import vec3
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Content, Placed, Prefabs, Scenes

from game.actions import Controls, CutsceneControls
from game.components import Breakable, Foe, Gate, KeyFor, Pickup, Projectile, Room
from game.cover_layout import SIDES, TileSpec, pinned_open, reachable_open, solve
from game.events import Descended
from game.floor_plan import plan_floor, solvable
from game.resources import Outcome, Run, Vault
from game.rules import Rules
from game.ui import PauseMenu, RunOverPanel, TitleScreen


async def start_run(game: GameHarness) -> None:
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await game.advance_until(lambda: game.world.query(Room).count() > 0)


def keeper_health(game: GameHarness) -> Health:
    return game.world.placed(Placed.keeper).get(Health)


@playtest("a run starts with the rules' loadout and a locked boss gate")
async def run_starts(game: GameHarness):
    await start_run(game)
    run = game.get(Run)
    assert (keeper_health(game).current, run.bombs, run.coins) == (6, 1, 0)
    kinds = [room.kind for _, room in game.world.query(Room)]
    assert kinds.count(Content.room.start) == 1 and kinds.count(Content.room.boss) == 1
    assert any(gate.locked for _, gate in game.world.query(Gate))


@playtest("standing in a combat room spawns its squad and shuts its gates")
async def combat_room_engages(game: GameHarness):
    await start_run(game)
    await game.advance(seconds=1)  # unlocked gates have sunk open
    room_entity = next(entity for entity, room in game.world.query(Room) if room.kind == Content.room.combat)
    game.world.placed(Placed.keeper).transform.position = room_entity.transform.position
    await game.advance(seconds=1)
    assert room_entity.get(Room).fighting
    assert game.world.query(Foe).where(lambda _, foe: foe.room == room_entity).count() > 0
    assert all(
        entity.transform.position.y == 0
        for entity, gate in game.world.query(Gate) if room_entity in gate.between
    )


@playtest("a heart on the floor restores a whole heart")
async def heart_heals(game: GameHarness):
    await start_run(game)
    health = keeper_health(game)
    health.current = 2
    keeper = game.world.placed(Placed.keeper)
    game.world.spawn(Prefabs.pickup, at=keeper.transform.position, components=[Pickup(item=Content.item.heart)])
    await game.advance(seconds=0.2)
    assert health.current == 4


@playtest("the keeper's wounds carry down to the next floor")
async def health_carries_down(game: GameHarness):
    await start_run(game)
    keeper_health(game).current = 3
    game.world.spawn(Prefabs.exit_pad, at=game.world.placed(Placed.keeper).transform.position)
    await game.until(Descended)
    await game.advance(frames=2)  # the floor reloads at the end of the frame
    assert game.get(Run).floor == 1
    assert keeper_health(game).current == 3


@playtest("a bomb is spent")
async def bomb_spent(game: GameHarness):
    await start_run(game)
    await game.press(Controls.bomb)
    assert game.get(Run).bombs == 0


@playtest("the title has no pause key")
async def no_pause_on_title(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("walking out from the pause menu banks the coins and returns to the title")
async def walk_out_banks_coins(game: GameHarness):
    await start_run(game)
    game.get(Run).coins = 7
    banked_before = game.get(Vault).coins
    await game.press(Controls.pause)
    await game.click(PauseMenu, "abandon")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.title)
    assert game.get(Vault).coins == banked_before + 7


@playtest("P pauses the floor and P resumes it")
async def pause_toggles(game: GameHarness):
    await start_run(game)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("falling banks the coins carried out")
async def fall_banks_coins(game: GameHarness):
    await start_run(game)
    game.get(Run).coins = 9
    keeper_health(game).current = 1
    banked_before = game.get(Vault).coins
    keeper = game.world.placed(Placed.keeper)
    game.world.spawn(Prefabs.spit, at=keeper.transform.position,
                     components=[Projectile(velocity=vec3(), damage=1, lifetime=1)])
    await game.advance_until(lambda: game.is_open(RunOverPanel))
    assert game.get(Run).outcome is Outcome.FELL
    assert game.get(Vault).coins == banked_before + 9


@playtest("every floor plan with two locks stays solvable, keys outside their own rooms")
async def deep_floor_plans_are_solvable(game: GameHarness):
    await game.start(scene=Scenes.title)
    for _ in range(30):
        plan = plan_floor(9, 3, 0.15, True, 2)
        assert sorted(plan.keys.keys()) == [0, 1]
        assert [kind for cell, kind in plan.kinds.items() if plan.locks.get(cell) == 0] == ["boss"]
        assert all(plan.keys[lock] != cell for cell, lock in plan.locks.items())
        assert solvable(plan.kinds, plan.links, plan.locks, plan.keys)


@playtest("the deep vault has a second lock with its own key, and each key opens only its gates")
async def second_lock_on_deep_floors(game: GameHarness):
    await start_run(game)
    assert game.world.query(KeyFor).count() == 1
    game.get(Run).floor = 1
    game.world.spawn(Prefabs.exit_pad, at=game.world.placed(Placed.keeper).transform.position)
    await game.until(Descended)
    await game.advance(frames=2)
    assert game.get(Run).floor == 2
    assert sorted([key.lock for _, key in game.world.query(KeyFor)]) == [0, 1]
    assert {gate.lock for _, gate in game.world.query(Gate) if gate.locked} == {0, 1}
    second = [entity for entity, key in game.world.query(KeyFor) if key.lock == 1][0]
    game.world.placed(Placed.keeper).transform.position = second.transform.position
    await game.advance(seconds=0.3)
    assert {gate.lock for _, gate in game.world.query(Gate) if gate.locked} == {0}


@playtest("a fight room's cover is whole wall runs that keep the ring and centre open")
async def cover_layout_is_consistent(game: GameHarness):
    await game.start(scene=Scenes.title)
    rules = game.config(Rules)
    tiles = [TileSpec(id=t.id, weight=t.weight, edges={"n": t.n, "e": t.e, "s": t.s, "w": t.w})
             for t in rules.cover_tiles]
    size = rules.cover_size
    pins = {cell: 0 for cell in pinned_open(size, rules.cover_centre)}
    for _ in range(10):
        grid = solve(tiles, size, pins, rules.cover_restarts)
        assert grid is not None
        for cell, tile in grid.items():
            for side, facing, step in SIDES:
                there = cell + step
                if there in grid:
                    assert tiles[tile].edges[side] == tiles[grid[there]].edges[facing]
        assert all(grid[cell] == 0 for cell in pins)
        cover = {cell: rules.cover_tiles[tile].prefab is not None for cell, tile in grid.items()}
        covered = len([cell for cell in cover if cover[cell]])
        assert 0 < covered < 32
        assert len(reachable_open(cover, size)) > 2 * size


@playtest("a fight room raises its cover and breakables, and a broken crate is gone")
async def fight_room_dressed(game: GameHarness):
    await start_run(game)
    breakables_before = game.world.query(tagged=Breakable).count()
    room_entity = next(entity for entity, room in game.world.query(Room) if room.kind == Content.room.combat)
    game.world.placed(Placed.keeper).transform.position = room_entity.transform.position
    await game.advance(seconds=0.5)
    assert game.world.query(tagged=Breakable).count() == breakables_before + game.config(Rules).breakables_per_room
    crate = [entity for entity in game.world.query(tagged=Breakable)][0]
    crate.get(Health).damage(100)
    await game.advance(frames=2)
    assert not crate.alive


@playtest("walking into the boss room plays the intro: the boss waits in the centre, P skips")
async def boss_intro_plays(game: GameHarness):
    await start_run(game)
    room_entity = next(entity for entity, room in game.world.query(Room) if room.kind == Content.room.boss)
    center = room_entity.transform.position
    game.world.placed(Placed.keeper).transform.position = center + vec3(0, 0, 5)
    await game.advance(seconds=0.5)
    assert game.ctx.cinematics.playing
    boss = game.world.query(Foe).where(lambda _, foe: foe.kind.data.boss).entities()[0]
    assert boss.transform.position.distance_to(center) < 0.5
    await game.advance(seconds=1)
    assert boss.transform.position.distance_to(center) < 0.5
    await game.press(CutsceneControls.skip)
    await game.advance(frames=2)
    assert not game.ctx.cinematics.playing
    assert not game.is_open(PauseMenu)
