from parallax import Vec3
from parallax.characters import Character
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from parallax.values import Cell3
from project import Content, Placed, Scenes

from features.inventory.components import Pickup
from features.inventory.events import LootDropped
from features.inventory.feature import ChestPanel, CraftingPanel, Inventory, count_of
from features.survival.feature import Run, Vitals
from game.actions import Controls
from game.components import Hostile
from game.content import Stack
from game.events import Used
from game.ui import TitleScreen


async def new_world(h: GameHarness):
    await h.start(scene=Scenes.greenwood)
    return h.world.placed(Placed.player)


@playtest("the title's Challenge starts a world with limited lives")
async def starts_challenge(h: GameHarness):
    await h.start(scene=Scenes.title)
    await h.click(TitleScreen, "challenge")
    await h.advance(frames=1)
    assert h.ctx.scenes.current_is(Scenes.greenwood)
    assert h.get(Run).challenge


@playtest("a log becomes four planks in the backpack")
async def crafts_planks(h: GameHarness):
    player = await new_world(h)
    player.get(Inventory).slots = [Stack(Content.item.wood_log, 1)] + [Stack()] * 35
    await h.press(Controls.craft)
    assert h.is_open(CraftingPanel)
    await h.click(CraftingPanel, "craft", recipe="planks")
    slots = player.get(Inventory).slots
    assert count_of(slots, Content.item.planks) == 4
    assert count_of(slots, Content.item.wood_log) == 0


@playtest("using a chest opens its panel, and a click stores a stack in it")
async def stores_in_chest(h: GameHarness):
    player = await new_world(h)
    cell = Cell3(3, h.ctx.voxels.surface_height(Vec3(3, 0, 3)), 3)
    h.ctx.voxels.set(cell, Content.block.chest)
    chest = h.ctx.voxels.block_entity(cell)
    h.ctx.emit(Used(entity=chest, by=player))
    await h.advance(frames=1)
    assert h.is_open(ChestPanel)
    await h.click(ChestPanel, "store", slot=0)
    assert count_of(chest.get(Inventory).slots, Content.item.berries) == 3
    await h.click(ChestPanel, "close")
    assert not h.is_open(ChestPanel)


@playtest("hunger drains and the starting berries refill it")
async def eats_berries(h: GameHarness):
    player = await new_world(h)
    vitals = player.get(Vitals)
    await h.advance(seconds=60)
    hungry = vitals.hunger
    assert hungry < vitals.max_hunger
    await h.press(Controls.eat)
    assert vitals.hunger > hungry
    assert count_of(player.get(Inventory).slots, Content.item.berries) == 2


@playtest("an empty stomach hurts")
async def starves(h: GameHarness):
    player = await new_world(h)
    player.get(Vitals).hunger = 0
    health = player.get(Health)
    before = health.current
    await h.advance(seconds=5)
    assert health.current < before


@playtest("hostiles come out at night and are gone by the next morning")
async def night_and_day(h: GameHarness):
    player = await new_world(h)
    player.get(Health).minimum = 1  # watch the night, don't lose to it
    h.ctx.environment.time_of_day = 21
    await h.advance_until(lambda: h.world.query(tagged=Hostile).count() > 0, timeout=30)
    # Skip to just before dawn (6:00): simulating the whole night was ~6 game minutes of a
    # populated world, 30-45 s of wall time, and under load it overran the runner's 60 s limit.
    h.ctx.environment.time_of_day = 5.9
    assert h.world.query(tagged=Hostile).count() > 0, "still night: the hostiles are out"
    await h.advance_until(lambda: h.world.query(tagged=Hostile).count() == 0, timeout=30)
    assert h.ctx.environment.day == 1
    assert not h.ctx.environment.is_night


@playtest("in water, holding jump swims up and letting go sinks slowly")
async def swims(h: GameHarness):
    player = await new_world(h)
    x, z = 6, 6
    floor = h.ctx.voxels.surface_height(Vec3(x, 0, z))
    for y in range(floor, floor + 6):  # a 6-deep shaft of water on top of the ground
        h.ctx.voxels.set(Cell3(x, y, z), Content.block.water)
    player.get(Character).teleport(Vec3(x + 0.5, floor + 1.0, z + 0.5))
    await h.advance(frames=2)
    start = player.transform.position.y
    await h.hold(Controls.jump, 0.5)
    risen = player.transform.position.y
    assert risen > start + 0.8, "holding jump rises through the water"
    await h.advance(seconds=0.5)
    assert risen - player.transform.position.y < 1.0, "it sinks slower than it falls"


@playtest("the weather cycles from clear, and the beacon siege brings a storm")
async def weather(h: GameHarness):
    player = await new_world(h)
    assert h.ctx.weather.preset == "clear"
    cell = Cell3(4, h.ctx.voxels.surface_height(Vec3(4, 0, 4)), 4)
    h.ctx.voxels.set(cell, Content.block.beacon)
    h.ctx.emit(Used(entity=h.ctx.voxels.block_entity(cell), by=player))
    await h.advance(frames=1)
    assert h.ctx.weather.preset == "storm"


@playtest("loot dropped beside a matching pickup tops that pickup up instead of piling a new one")
async def loot_merges(h: GameHarness):
    player = await new_world(h)
    at = player.transform.position + Vec3(2, 0, 0)
    h.ctx.emit(LootDropped(stacks=[Stack(Content.item.berries, 1)], at=at))
    await h.advance(frames=2)
    h.ctx.emit(LootDropped(stacks=[Stack(Content.item.berries, 2)], at=at))
    await h.advance(frames=2)
    berries = [p for _, p in h.world.query(Pickup) if p.stack.item == Content.item.berries]
    assert len(berries) == 1 and berries[0].stack.count == 3
