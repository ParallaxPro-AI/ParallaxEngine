from parallax import Vec3
from parallax.combat import Health
from parallax.softbody import Cloth
from parallax.test import playtest
from project import Content, Prefabs, Scenes

from game.actions import Helm
from game.components import Cannonball, CrewShip, CursedHoard, Ghost, TreasureChest
from game.standing import rank
from game.resources import Phase, Voyage
from game.ui import GameOverPanel, Hud, RefitPanel, TitleScreen


async def leave_title(game):
    """The title card is up first (as in the template); Set Sail goes to the refit."""
    await game.start(scene=Scenes.bay)
    assert game.is_open(TitleScreen) and not game.is_open(RefitPanel)
    await game.click(TitleScreen, "set_sail")
    await game.advance(frames=2)


async def set_sail(game):
    """Leave the title, take the first refit card, as a captain would, and wait for the launch."""
    await leave_title(game)
    assert game.is_open(RefitPanel)
    await game.click(RefitPanel, "pick", upgrade=game.get(Voyage).offers[0].id)
    await game.advance_until(lambda: game.world.query(tagged=CrewShip).count() == 1, timeout=2)


def my_ship(game):
    return game.world.query(tagged=CrewShip).single()


@playtest("the first refit pick fits the fleet, starts the clock and launches the ship")
async def test_refit_launches(game):
    await set_sail(game)
    voyage = game.get(Voyage)
    assert voyage.phase is Phase.SAILING
    assert sum(voyage.levels.values()) == 1
    assert not game.is_open(RefitPanel)


@playtest("hoisting sail gets the ship under way")
async def test_sailing(game):
    await set_sail(game)
    start = my_ship(game).transform.position
    await game.set_axis(Helm.sail, 1, seconds=6)
    assert my_ship(game).transform.position.distance_to(start) > 5


@playtest("a broadside spawns a ball on the side that was fired")
async def test_broadside(game):
    await set_sail(game)
    await game.press(Helm.fire_starboard)
    await game.advance(frames=1)
    ball, shot = game.world.query(Cannonball).single()
    assert shot.shooter == my_ship(game)
    assert (ball.transform.position - my_ship(game).transform.position).dot(my_ship(game).transform.right) > 0


@playtest("sailing over a chest scoops it into the hold")
async def test_scoop(game):
    await set_sail(game)
    chest = game.world.spawn(Prefabs.treasure_chest, at=my_ship(game).transform.position + Vec3(0, 0.5, 0))
    await game.advance(frames=2)
    assert game.get(Voyage).leg_gold > 0
    # The sea is stocked on the first sailing frame, so count this chest, not the field.
    assert not chest.alive


@playtest("a sunk ship spends a crew and is relaunched")
async def test_sinking(game):
    await set_sail(game)
    my_ship(game).get(Health).kill()
    await game.advance(frames=2)
    assert game.get(Voyage).sinkings == 1
    assert game.world.query(tagged=CrewShip).count() == 0
    await game.advance_until(lambda: game.world.query(tagged=CrewShip).count() == 1, timeout=8)


@playtest("filling the hold and honouring the bounty sails on to the next sea")
async def test_leg_cleared(game):
    await set_sail(game)
    voyage = game.get(Voyage)
    voyage.leg_gold, voyage.bounty = 10_000, 10
    await game.advance_until(lambda: game.get(Voyage).leg == 1, timeout=2)
    assert game.get(Voyage).phase is Phase.REFIT


@playtest("losing the last crew ends the voyage")
async def test_voyage_lost(game):
    await set_sail(game)
    game.get(Voyage).sinkings = 10
    my_ship(game).get(Health).kill()
    await game.advance(frames=3)
    assert game.get(Voyage).phase is Phase.ENDED
    assert game.is_open(GameOverPanel)


@playtest("a launched ship carries the refit build on top of its prefab's stats")
async def test_refit_modifies_the_hull(game):
    await leave_title(game)
    game.get(Voyage).levels["hull_plate"] = 1
    await game.click(RefitPanel, "pick", upgrade=game.get(Voyage).offers[0].id)
    await game.advance_until(lambda: game.world.query(tagged=CrewShip).count() == 1, timeout=2)
    hull = my_ship(game).get(Health)
    assert hull.max >= 200 + 70
    assert hull.current == hull.max


@playtest("a launched ship floats on the ocean's waterline instead of sinking or flying")
async def test_ship_floats(game):
    await set_sail(game)
    await game.advance(seconds=4)
    ship = my_ship(game).transform.position
    level = game.ctx.water.height_at(ship)
    assert -2.5 < ship.y - level < 1.5, f"hull origin {ship.y:.2f} vs water {level:.2f}"


@playtest("Q takes a ghost contract; sinking its hulls pays the purse and the Crown notices")
async def test_ghost_contract(game):
    await set_sail(game)
    await game.press(Helm.contract)
    voyage = game.get(Voyage)
    assert voyage.contract == Content.contract.hunt_ghosts
    await game.press(Helm.contract)
    assert voyage.contracts_taken == 1, "one contract open at a time"
    before = voyage.leg_gold
    ghosts = [ghost for ghost in game.world.query(tagged=Ghost)][:2]
    assert len(ghosts) == 2, "the bay has ghost ships to hunt"
    for ghost in ghosts:
        ghost.get(Health).kill()
    await game.advance(frames=2)
    assert voyage.contract is None, "two haunted hulls sunk: the contract is done"
    # 2 × 70 bounty + 120 contract, before any standing perk moved the multiplier.
    assert voyage.leg_gold - before >= 2 * 70 + 120
    crown = voyage.standing["crown"]
    # Two ghost kills (+6 each, and the Guild's +2 warms its ally the Crown by 0.25 × 2),
    # then the Crown's contract (+10).
    assert crown == 2 * (6 + 2 * 0.25) + 10, crown
    assert voyage.standing["brethren"] < 0, "the Brethren cool when the Crown warms"
    assert game.ctx.text(rank(game.ctx, Content.faction.crown).name) == "Unknown"


@playtest("a treasure contract scatters cursed hoards; raising them all pays out")
async def test_treasure_contract(game):
    await set_sail(game)
    voyage = game.get(Voyage)
    voyage.contracts_taken = 1  # the board's second job: Recover 3 cursed hoards
    await game.press(Helm.contract)
    assert voyage.contract == Content.contract.cursed_gold
    hoards = game.world.query(tagged=CursedHoard).entities()
    assert len(hoards) == 3
    gold = voyage.leg_gold
    for hoard in hoards:
        my_ship(game).transform.position = hoard.transform.position
        await game.advance(frames=2)
    assert voyage.contract is None
    assert voyage.leg_gold - gold >= 100
    assert voyage.standing["brethren"] >= 10


@playtest("standing is worth something: a Privateer's bounties and a Partner's shelf")
async def test_standing_perks(game):
    await leave_title(game)
    voyage = game.get(Voyage)
    voyage.standing["merchants"] = 60  # Partner: one more refit card
    game.ctx.scenes.load(Scenes.bay)
    await game.advance(frames=2)
    assert len(game.get(Voyage).offers) == 4
    await game.click(RefitPanel, "pick", upgrade=game.get(Voyage).offers[0].id)
    await game.advance_until(lambda: game.world.query(tagged=CrewShip).count() == 1, timeout=2)
    voyage = game.get(Voyage)
    voyage.standing["crown"] = 30  # Privateer: bounties +15 %
    voyage.levels.pop("letter_of_marque", None)
    gold = voyage.leg_gold
    ghost = next(iter(game.world.query(tagged=Ghost)))
    ghost.get(Health).kill()
    await game.advance(frames=2)
    assert voyage.leg_gold - gold == round(70 * 1.15)


@playtest("the spyglass points at the open contract's quarry; the masthead pennant is cloth")
async def test_spyglass_and_pennant(game):
    await set_sail(game)
    hud = game.panel_state(Hud)
    assert hud["spyglass"] and hud["spy_label"] == "Treasure", "no contract: the nearest chest"
    await game.press(Helm.contract)
    await game.advance(frames=1)
    hud = game.panel_state(Hud)
    assert hud["spy_label"] == "Ghost Ship" and -180 <= hud["spy_bearing"] <= 180
    assert hud["has_contract"] and len(hud["standing"]) == 3
    pennant = my_ship(game).child("pennant")
    assert pennant.get(Cloth).particle_count == 12 * 7


@playtest("Sail With a Crew hosts a co-op room; Weigh Anchor takes the crew to the refit")
async def sail_with_a_crew(game):
    await game.start(scene=Scenes.bay)
    await game.click(TitleScreen, "sail_with_crew")
    await game.advance(frames=3)
    title = game.panel_state(TitleScreen)
    assert title["in_room"] and title["can_start"] and "1/6" in title["room_line"]
    await game.click(TitleScreen, "start_crew")
    await game.advance(frames=3)
    assert not game.is_open(TitleScreen) and game.is_open(RefitPanel)
    cards = game.panel_state(RefitPanel)["cards"]
    assert len(cards) >= 3 and all(card["icon"] for card in cards)
