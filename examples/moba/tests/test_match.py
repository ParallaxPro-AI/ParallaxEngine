from parallax import vec3
from parallax.combat import Health, Side
from parallax.test import GameHarness, playtest
from project import Content, Scenes

from features.comms.feature import ChatBox
from features.economy.feature import Items, ShopPanel, Wallet
from features.fighting.feature import Attacker
from features.heroes.feature import AbilityBook, CastRequested, Hero, Mana, WardRequested
from features.vision.components import Ward, WardKit
from features.lanes.feature import Minion
from features.match.feature import DraftBoard, GameOverScreen, Record
from game.actions import Controls
from game.components import Blue, Core, Red, Tower
from game.audio import MusicIntensity
from game.resources import Match, Phase
from game.ui import Hud, PauseMenu, TacticalMap, TitleScreen


async def drafted(h: GameHarness, mine: str = "mage", theirs: str = "warrior"):
    """Start the arena with both seats, draft and lock in for each, and return
    seat 0's champion. Locking in both ends the draft without waiting out the clock."""
    await h.start(scene=Scenes.arena, players=2)
    for player, champion in ((0, mine), (1, theirs)):
        await h.click(DraftBoard, "pick", player=player, champion=champion)
        await h.click(DraftBoard, "lock", player=player)
    await h.advance_until(lambda: h.get(Match).phase is Phase.PLAYING, timeout=1)
    return h.ctx.players[0].entity


@playtest("the drafted champion is the one that takes the field")
async def draft_equips_pick(h: GameHarness):
    hero = await drafted(h, "tank")
    assert hero.get(Hero).champion == Content.champion.tank
    assert hero.get(Health).max == 720 + 110


@playtest("the last hit on a minion pays the champion who landed it")
async def last_hit_pays(h: GameHarness):
    hero = await drafted(h)
    await h.advance_until(lambda: h.world.query(Minion).count() > 0, timeout=10)
    enemy = next(e for e, _, side in h.world.query(Minion, Side) if side.side == Red)
    hero.transform.position = enemy.transform.position
    enemy.get(Health).current = 1
    gold = hero.get(Wallet).gold
    hero.get(Attacker).target = enemy
    await h.advance_until(lambda: not enemy.alive, timeout=5)
    assert hero.get(Wallet).gold >= gold + Content.unit.melee.data.gold


@playtest("an ability needs a rank, then goes on cooldown")
async def ability_rank_and_cooldown(h: GameHarness):
    hero = await drafted(h)
    mana = hero.get(Mana)
    full = mana.current
    await h.press(Controls.ability_q)
    assert mana.current == full
    await h.click(Hud, "rank_up", slot=0)
    assert hero.get(AbilityBook).ranks[0] == 1
    await h.press(Controls.ability_q)
    spent = mana.current
    cooldown_ends = hero.get(AbilityBook).ready_at[0]
    assert spent < full
    assert cooldown_ends > h.ctx.time.now
    await h.press(Controls.ability_q)
    # On cooldown: no second cast. The champion stands in the fountain and regenerates,
    # so mana may rise between the presses, but it must not be charged again.
    assert hero.get(AbilityBook).ready_at[0] == cooldown_ends
    assert mana.current >= spent


@playtest("a shield soaks up a hit before health does, then runs out")
async def shield_absorbs_and_expires(h: GameHarness):
    hero = await drafted(h)
    health = hero.get(Health)
    health.add_shield(100, seconds=2)
    before = health.current
    health.damage(60)
    assert health.current == before
    await h.advance(seconds=2.5)
    assert health.shield == 0


@playtest("an upgrade consumes its component and is discounted by it")
async def upgrade_discount(h: GameHarness):
    hero = await drafted(h)
    hero.get(Wallet).gold = 2000
    await h.press(Controls.shop)
    await h.click(ShopPanel, "buy", item="copper_band")
    await h.click(ShopPanel, "buy", item="reaver_fang")
    assert hero.get(Items).owned == [Content.item.reaver_fang]
    assert hero.get(Wallet).gold == 2000 - 250 - (1250 - 250)


@playtest("an item's stats stack on the champion's own")
async def item_stats_stack(h: GameHarness):
    hero = await drafted(h, "tank")
    hero.get(Wallet).gold = 2000
    await h.press(Controls.shop)
    await h.click(ShopPanel, "buy", item="rough_hide")
    assert hero.get(Health).max == 720 + 110 + 90


@playtest("destroying the enemy core ends the match, and each player's record counts it")
async def core_falls_ends_match(h: GameHarness):
    hero = await drafted(h)
    red_core = next(e for e, side in h.world.query(Side, tagged=Core) if side.side == Red)
    red_core.get(Health).kill(source=hero)
    await h.advance(frames=2)
    match = h.get(Match)
    assert match.phase is Phase.ENDED and match.winner == Blue
    assert h.is_open(GameOverScreen, player=0) and h.panel_state(GameOverScreen, player=0)["won"]
    assert not h.panel_state(GameOverScreen, player=1)["won"]
    assert h.panel_state(GameOverScreen, player=0)["record"].startswith("1W")
    assert h.panel_state(GameOverScreen, player=1)["record"].endswith("1L")
    await h.click(GameOverScreen, "main_menu", player=0)
    await h.advance(frames=2)
    assert h.ctx.scenes.current_is(Scenes.title)


@playtest("right-click walks the champion to the pointer")
async def order_walks(h: GameHarness):
    hero = await drafted(h)
    start = hero.transform.position
    target = start + vec3(0, 0, -7)
    await h.tap_world(target)
    await h.press(Controls.order)
    await h.advance(seconds=2)
    assert (hero.transform.position - target).flat().length() < (start - target).flat().length() - 3


@playtest("a skillshot hits every enemy on its line and nothing beside it")
async def skillshot_line(h: GameHarness):
    hero = await drafted(h, "mage")
    enemy = h.ctx.players[1].entity
    here = hero.transform.position
    beside = next(e for e, _, side in h.world.query(Hero, Side) if side.side == Red and e != enemy)
    enemy.transform.position = here + vec3(8, 0, 0)
    beside.transform.position = here + vec3(8, 0, 3)
    await h.advance(seconds=0.5)
    await h.click(Hud, "rank_up", slot=0)
    hp = enemy.get(Health).current
    beside_hp = beside.get(Health).current
    # What Q does with the pointer at here + 14 m east (PlayerCommand emits exactly this).
    h.ctx.emit(CastRequested(hero=hero, slot=0, aim=here + vec3(14, 0, 0)))
    await h.advance(frames=2)
    assert enemy.get(Health).current < hp
    assert beside.get(Health).current == beside_hp


@playtest("a chat line reaches both players")
async def chat_line(h: GameHarness):
    await drafted(h)
    await h.click(ChatBox, "send", player=0, text="gl hf")
    await h.advance(frames=2)
    for seat in (0, 1):
        assert [line["text"] for line in h.panel_state(ChatBox, player=seat)["lines"]] == ["gl hf"]


@playtest("a core takes a quarter of each hit until both its base towers fall")
async def core_guarded_by_base_towers(h: GameHarness):
    await drafted(h)
    red_core = next(e for e, side in h.world.query(Side, tagged=Core) if side.side == Red)
    health = red_core.get(Health)
    before = health.current
    health.damage(400)
    assert before - health.current == 100
    for tower in h.world.query(tagged=Tower).near(red_core.transform.position, 12):
        tower.get(Health).kill()
    await h.advance(frames=2)
    before = health.current
    health.damage(400)
    assert before - health.current == 400


@playtest("minion waves march out of the base down their lanes")
async def waves_march(h: GameHarness):
    await drafted(h)
    await h.advance_until(lambda: h.world.query(Minion).count() > 0, timeout=10)
    blue_core = next(e for e, side in h.world.query(Side, tagged=Core) if side.side == Blue)
    home = blue_core.transform.position
    await h.advance(seconds=8)
    blues = [e for e, _, side in h.world.query(Minion, Side) if side.side == Blue]
    assert blues and max((e.transform.position - home).flat().length() for e in blues) > 20


@playtest("fallen towers count for the other team, and a core left unguarded is announced on every HUD")
async def towers_count_and_core_exposed(h: GameHarness):
    hero = await drafted(h)
    red_core = next(e for e, side in h.world.query(Side, tagged=Core) if side.side == Red)
    guards = h.world.query(tagged=Tower).near(red_core.transform.position, 12).to_list()
    assert len(guards) == 2
    guards[0].get(Health).kill(source=hero)
    await h.advance(frames=2)
    match = h.get(Match)
    assert match.blue_towers == 1 and not match.red_core_exposed
    assert h.panel_state(Hud, player=0)["feed"][0]["victim"] == "Tower"
    guards[1].get(Health).kill(source=hero)
    await h.advance(frames=2)
    assert match.blue_towers == 2 and match.red_core_exposed
    hud = h.panel_state(Hud, player=0)
    assert hud["banner_on"] and hud["banner_color"] == "#f2c14e"
    assert hud["objective"] == "Enemy core exposed — end it" and not hud["objective_warn"]


@playtest("the match music's intensity rises with the fighting and decays when it stops")
async def music_intensity(h: GameHarness):
    hero = await drafted(h)
    start = h.get(MusicIntensity).value
    assert start > 0.1
    await h.advance(seconds=2)
    calm = h.get(MusicIntensity).value
    assert calm < start
    enemy = h.ctx.players[1].entity
    enemy.get(Health).kill(source=hero)
    await h.advance(frames=2)
    assert h.get(MusicIntensity).value > calm + 0.25


@playtest("Training with Bots seats you alone: the draft, then the match with your HUD")
async def training_with_bots(h: GameHarness):
    await h.start(scene=Scenes.title, players=1)
    await h.click(TitleScreen, "training")
    await h.advance_until(lambda: h.get(Match).phase is Phase.DRAFT, timeout=3)
    await h.advance(frames=2)
    assert h.is_open(DraftBoard)
    await h.click(DraftBoard, "pick", champion="archer")
    await h.click(DraftBoard, "lock")
    await h.advance_until(lambda: h.get(Match).phase is Phase.PLAYING, timeout=1)
    await h.advance(frames=2)
    assert h.is_open(Hud)
    assert h.ctx.players[0].entity.get(Hero).champion == Content.champion.archer



async def training(h: GameHarness):
    await h.start(scene=Scenes.title, players=1)
    await h.click(TitleScreen, "training")
    await h.advance_until(lambda: h.get(Match).phase is Phase.DRAFT, timeout=3)
    await h.advance(frames=2)
    await h.click(DraftBoard, "pick", champion="archer")
    await h.click(DraftBoard, "lock")
    await h.advance_until(lambda: h.get(Match).phase is Phase.PLAYING, timeout=1)
    return h.ctx.players[0].entity


@playtest("in Training the menu pauses the match; online it does not")
async def training_menu_pauses(h: GameHarness):
    await training(h)
    await h.press(Controls.menu)
    await h.advance(frames=2)
    assert h.is_open(PauseMenu) and h.panel_state(PauseMenu)["training"]
    before = h.ctx.time.now
    await h.advance(seconds=2)
    assert h.ctx.time.now - before < 0.1
    await h.click(PauseMenu, "resume")
    await h.advance(seconds=1)
    assert h.ctx.time.now - before > 0.5


@playtest("bots wait round the base for the first wave, then walk out with it")
async def bots_wait_for_first_wave(h: GameHarness):
    await training(h)
    bots = [e for e, _ in h.world.query(Hero) if e.owner is None]
    start = [e.transform.position for e in bots]
    await h.advance(seconds=3)
    assert all((e.transform.position - p).flat().length() < 2 for e, p in zip(bots, start))
    await h.advance(seconds=8)
    assert any((e.transform.position - p).flat().length() > 4 for e, p in zip(bots, start))


@playtest("a Watchfire plants once; the Hushbell breaks enemy wards in its circle")
async def watchfire_and_hushbell(h: GameHarness):
    hero = await drafted(h)
    enemy = h.ctx.players[1].entity
    # At the red fountain: the red bots there don't attack a red ward.
    hero.transform.position = enemy.transform.position + vec3(-8, 0, 0)
    at = hero.transform.position + vec3(4, 0, 0)
    enemy.transform.position = hero.transform.position + vec3(30, 0, 0)
    h.ctx.emit(WardRequested(hero=enemy, at=at, kind="watchfire"))
    await h.advance(frames=2)
    assert h.world.query(Ward).count() == 0  # out of the 24 m reach
    enemy.transform.position = hero.transform.position + vec3(6, 0, 0)
    h.ctx.emit(WardRequested(hero=enemy, at=at, kind="watchfire"))
    await h.advance(frames=2)
    assert h.world.query(Ward).count() == 1 and enemy.get(WardKit).watchfires == 0, f"{h.world.query(Ward).count()} {enemy.get(WardKit).watchfires}"
    h.ctx.emit(WardRequested(hero=hero, at=at, kind="hushbell"))
    await h.advance(frames=2)
    assert h.world.query(Ward).count() == 0
    assert hero.get(WardKit).hush_at > h.ctx.time.now


@playtest("the tactical map sits in the HUD with the derived base map")
async def tactical_map(h: GameHarness):
    await training(h)
    await h.advance(frames=3)
    assert h.is_open(TacticalMap) and h.panel_state(TacticalMap)["base"].startswith("data:image/svg+xml")
