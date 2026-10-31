from parallax import Entity, Model, Vec3, vec3
from parallax.characters import Character
from parallax.test import playtest
from project import Content, Scenes

from game.actions import ChefControls
from game.components import Chef, Pot, PotState, Station
from game.resources import Orders, Result, Service, Ticket
from game.rules import time_left
from game.ui import ChefCard, ChefGuide, KitchenOrders, KitchenTop, PauseMenu, ServiceOver, TitleScreen

# Where a chef stands to use each station of The Diner.
TOMATO_CRATE = vec3(-10, 0, 6)
BOARD = vec3(-4, 0, 6)
FRIDGE = vec3(16, 0, 6)
STOVE = vec3(-6, 0, -6)
WINDOW = vec3(0, 0, -6)
PLATING_LEFT = vec3(3, 0, -6)
PLATING_RIGHT = vec3(5, 0, -6)


async def open_kitchen(game):
    await game.start(scene=Scenes.diner, seed=5, players=2)
    assert game.is_open(TitleScreen)
    assert not game.is_open(KitchenTop)
    await game.click(TitleScreen, "start")
    assert game.is_open(KitchenTop)
    assert game.is_open(KitchenOrders)


def chef(game, seat: int) -> Entity:
    return game.ctx.players[seat].entity


def station_near(game, at: Vec3) -> Entity:
    station, _ = game.world.query(Station).nearest(at)
    return station


async def use_station(game, seat: int, standing_at: Vec3):
    chef(game, seat).get(Character).teleport(standing_at)
    await game.press(ChefControls.interact, player=seat)


@playtest("the clock waits for Open Kitchen")
async def test_title_holds_the_clock(game):
    await game.start(scene=Scenes.diner, seed=5, players=2)
    await game.advance(seconds=3)
    assert game.is_open(TitleScreen)
    await game.click(TitleScreen, "start")
    assert time_left(game.ctx) > Content.kitchen.diner.data.seconds - 0.5


@playtest("each seat's interact button drives only that seat's chef and card")
async def test_seats_are_independent(game):
    await open_kitchen(game)
    await use_station(game, 0, TOMATO_CRATE)
    assert chef(game, 0).get(Chef).held == Content.item.tomato
    assert chef(game, 1).get(Chef).held is None
    card = game.panel_state(ChefCard, player=0)
    assert card["holding"] == "tomato"
    assert card["step"] == "Step 2"
    assert card["task"] == "Chop the tomato"
    assert card["said"] == "\u2713 Grabbed a tomato"
    assert card["key_use"] == "E"
    assert game.panel_state(ChefCard, player=1)["holding"] == "nothing"
    assert game.panel_state(ChefCard, player=1)["key_use"] == "O"
    assert game.panel_state(ChefCard, player=1)["said"] == ""


@playtest("a chopped tomato served at the window clears its ticket and scores")
async def test_chop_and_serve(game):
    await open_kitchen(game)
    orders = game.get(Orders)
    orders.tickets = [Ticket(dish=Content.dish.tomato_plate, time_left=22, lifetime=22)]
    orders.next_in = 99
    await use_station(game, 0, TOMATO_CRATE)
    await use_station(game, 0, BOARD)
    assert chef(game, 0).get(Chef).held == Content.item.chopped_tomato
    assert game.panel_state(KitchenOrders)["tickets"][0]["dish"] == "Tomato Plate"
    await use_station(game, 0, WINDOW)
    service = game.get(Service)
    assert orders.tickets == []
    assert service.served == 1
    assert service.scores[0] >= Content.dish.tomato_plate.data.points
    assert game.panel_state(ChefCard, player=0)["said"].startswith("\u2713 Tomato Plate served!")


@playtest("serving a dish nobody ordered costs points and the streak")
async def test_wrong_dish(game):
    await open_kitchen(game)
    service = game.get(Service)
    service.scores = [10, 0]
    service.streak = 3
    game.get(Orders).tickets = []
    game.get(Orders).next_in = 99
    chef(game, 0).get(Chef).held = Content.item.salad
    await use_station(game, 0, WINDOW)
    assert service.scores == [5, 0]
    assert service.streak == 0
    card = game.panel_state(ChefCard, player=0)
    assert card["said_bad"] and card["said"] == "\u2715 Nobody ordered that!  \u22125"


@playtest("two chefs build one salad on a shared plating station")
async def test_shared_plate(game):
    await open_kitchen(game)
    chef(game, 0).get(Chef).held = Content.item.chopped_tomato
    chef(game, 1).get(Chef).held = Content.item.chopped_lettuce
    await use_station(game, 0, PLATING_LEFT)
    await use_station(game, 1, PLATING_RIGHT)
    await game.press(ChefControls.interact, player=1)
    assert chef(game, 1).get(Chef).held == Content.item.salad
    assert chef(game, 0).get(Chef).held is None


@playtest("a soup left on the heat burns and costs the team")
async def test_pot_burns(game):
    await open_kitchen(game)
    chef(game, 0).get(Chef).held = Content.item.chopped_tomato
    await use_station(game, 0, STOVE)
    pot = station_near(game, vec3(-6, 0, -8)).get(Pot)
    assert pot.state is PotState.COOKING
    assert game.panel_state(KitchenOrders)["pots"][0]["cooking"]
    await game.advance(seconds=5 + 9 + 0.5)
    assert pot.state is PotState.BURNT
    assert game.get(Service).burnt == 1
    await use_station(game, 0, STOVE)
    assert chef(game, 0).get(Chef).held == Content.item.burnt_food


@playtest("grabbing from the fridge swings its door open and shut")
async def test_fridge_door(game):
    await open_kitchen(game)
    fridge = station_near(game, vec3(16, 0, 8))
    await use_station(game, 0, FRIDGE)
    assert chef(game, 0).get(Chef).held == Content.item.lettuce
    await game.advance(seconds=0.6)
    assert fridge.get(Model).joint("fridge_door") > 30
    await game.advance(seconds=2)
    assert fridge.get(Model).joint("fridge_door") < 1


@playtest("the guide pins each chef's next station in that chef's half")
async def test_guide(game):
    await open_kitchen(game)
    chef(game, 0).get(Character).teleport(BOARD)
    chef(game, 0).get(Chef).held = Content.item.tomato
    await game.advance(frames=2)
    board = station_near(game, vec3(-4, 0, 8))
    assert chef(game, 0).get(Chef).goal == board
    guide = game.panel_state(ChefGuide, player=0)
    goals = [pin for pin in guide["pins"] if pin["goal"]]
    assert (len(goals) == 1 and goals[0]["label"] == "Board") or guide["edge"]
    assert guide["carrying"] and guide["held"] == "tomato"


@playtest("the bin is only a goal for burnt food")
async def test_guide_bin(game):
    await open_kitchen(game)
    bin_near = station_near(game, vec3(-12, 0, -8))
    chef(game, 0).get(Character).teleport(vec3(-12, 0, -6))
    chef(game, 0).get(Chef).held = Content.item.salad
    await game.advance(frames=2)
    assert chef(game, 0).get(Chef).goal != bin_near
    chef(game, 0).get(Chef).held = Content.item.burnt_food
    await game.advance(frames=2)
    assert chef(game, 0).get(Chef).goal == bin_near


@playtest("the pause card hides the service HUD and sets graphics quality")
async def test_pause(game):
    await open_kitchen(game)
    await game.press(ChefControls.pause, player=0)
    assert game.is_open(PauseMenu)
    assert not game.is_open(KitchenTop)
    assert game.panel_state(PauseMenu)["where"].startswith("The Diner · ")
    await game.click(PauseMenu, "quality", quality="low")
    assert game.panel_state(PauseMenu)["quality_low"] == "true"
    await game.click(PauseMenu, "resume")
    assert game.is_open(KitchenTop)


@playtest("an expired ticket counts as missed and breaks the streak")
async def test_ticket_expires(game):
    await open_kitchen(game)
    orders, service = game.get(Orders), game.get(Service)
    orders.tickets = [Ticket(dish=Content.dish.garden_salad, time_left=1, lifetime=22)]
    orders.next_in = 99
    service.streak = 2
    await game.advance(seconds=1.2)
    assert service.missed == 1
    assert service.streak == 0
    assert game.panel_state(KitchenOrders)["missed"]


@playtest("clearing a kitchen's target loads the next one with a full clock")
async def test_next_kitchen(game):
    await open_kitchen(game)
    game.get(Service).scores = [30, 15]
    await game.advance_until(lambda: game.get(Service).kitchen == 1, timeout=95)
    await game.advance_until(lambda: game.ctx.scenes.current_is(Scenes.galley), timeout=1)
    assert time_left(game.ctx) > Content.kitchen.galley.data.seconds - 1
    assert game.get(Service).scores == [30, 15]
    assert not game.is_open(TitleScreen)


@playtest("missing the target ends the service; Play Again starts over in the Diner")
async def test_out_of_time_and_retry(game):
    await open_kitchen(game)
    await game.advance_until(lambda: game.is_open(ServiceOver), timeout=95)
    assert game.get(Service).result is Result.LOST
    receipt = game.panel_state(ServiceOver)
    assert receipt["title"] == "Out of Time" and receipt["lost"]
    assert receipt["result"] == "Needed: 40 in The Diner"
    assert [pill["name"] for pill in receipt["kitchens"]] == ["\u2715 Diner", "Galley", "Line"]
    await game.click(ServiceOver, "play_again")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.diner)
    assert game.get(Service).result is Result.COOKING
    assert not game.is_open(TitleScreen)
    assert game.is_open(KitchenTop)
