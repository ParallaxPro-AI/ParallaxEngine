"""The garage's rules, written as panel actions: pick an owned car, buy a car or the
next tier of a part, choose the difficulty (which scales both the rivals and the purse),
and go to the current round's track. Each parameter is filled from the clicked card."""

from parallax import Context, ContentRef
from project import Scenes, Text

from game.audio import Sounds, play
from game.content import CarDef, DifficultyDef, PartDef, TimeOfDayDef, TrackDef, WeatherDef
from game.resources import Career, GarageMenu, RacePlan
from game.rules import next_track, owns


def quick_race(ctx: Context) -> None:
    """Title: race any track on your own terms."""
    ctx.get(RacePlan).championship = False
    ctx.scenes.load(Scenes.garage)


def championship(ctx: Context) -> None:
    """Title: the season, picked up at the round it was left on."""
    ctx.get(RacePlan).championship = True
    ctx.scenes.load(Scenes.garage)


def pick_car(ctx: Context, car: ContentRef[CarDef]) -> None:
    if owns(ctx, car):
        ctx.get(Career).car = car


def buy_car(ctx: Context, car: ContentRef[CarDef]) -> None:
    if owns(ctx, car) or not spend(ctx, car.data.price):
        return
    career = ctx.get(Career)
    career.purchased_cars.append(car)
    career.car = car


def buy_part(ctx: Context, part: ContentRef[PartDef]) -> None:
    career = ctx.get(Career)
    next_tier = career.part_tiers.get(part.id, 0) + 1
    if next_tier < len(part.data.tiers) and spend(ctx, part.data.tiers[next_tier].price):
        career.part_tiers[part.id] = next_tier


def pick_difficulty(ctx: Context, difficulty: ContentRef[DifficultyDef]) -> None:
    ctx.get(Career).difficulty = difficulty


def pick_track(ctx: Context, track: ContentRef[TrackDef]) -> None:
    ctx.get(RacePlan).track = track


def set_laps(ctx: Context, laps: int) -> None:
    ctx.get(RacePlan).laps = laps


def set_opponents(ctx: Context, opponents: int) -> None:
    ctx.get(RacePlan).opponents = opponents


def pick_weather(ctx: Context, weather: ContentRef[WeatherDef]) -> None:
    ctx.get(RacePlan).weather = weather


def pick_time(ctx: Context, time_of_day: ContentRef[TimeOfDayDef]) -> None:
    ctx.get(RacePlan).time_of_day = time_of_day


def race(ctx: Context) -> None:
    """A championship round decides the track, and so the scene; a quick race runs the
    picked one."""
    ctx.scenes.load(next_track(ctx))


def next_round(ctx: Context) -> None:
    """Results: straight on to the next round of the season."""
    ctx.scenes.load(next_track(ctx))


def spend(ctx: Context, price: int) -> bool:
    career = ctx.get(Career)
    if career.credits < price:
        ctx.ui.toast(Text.not_enough_credits)
        return False
    career.credits -= price
    play(ctx, ctx.config(Sounds).purchase)
    return True


# The template's screen flow: car select -> (garage) -> map select -> race settings.

def shown_car(ctx: Context) -> ContentRef[CarDef]:
    return ctx.get(GarageMenu).shown or ctx.get(Career).car


def to_car_select(ctx: Context) -> None:
    ctx.get(GarageMenu).screen = "car"


def to_garage_shop(ctx: Context) -> None:
    ctx.get(GarageMenu).screen = "garage"


def to_map_select(ctx: Context) -> None:
    ctx.get(GarageMenu).screen = "track"


def to_race_settings(ctx: Context) -> None:
    ctx.get(GarageMenu).screen = "settings"


def cycle_car(ctx: Context, step: int) -> None:
    """The arrows inspect every car; an owned one becomes the car you race."""
    cars = list(ctx.content(CarDef))
    car = cars[(cars.index(shown_car(ctx)) + step) % len(cars)]
    ctx.get(GarageMenu).shown = car
    pick_car(ctx, car)


def previous_car(ctx: Context) -> None:
    cycle_car(ctx, -1)


def next_car(ctx: Context) -> None:
    cycle_car(ctx, 1)


def buy_shown_car(ctx: Context) -> None:
    buy_car(ctx, shown_car(ctx))


def leave_car_select(ctx: Context) -> None:
    """Next: only with a car you own."""
    if owns(ctx, shown_car(ctx)):
        ctx.get(GarageMenu).screen = "track"


def pick_map(ctx: Context, track: ContentRef[TrackDef]) -> None:
    """A championship round picks the track itself."""
    if not ctx.get(RacePlan).championship:
        pick_track(ctx, track)


def set_option(ctx: Context, row: str, value: str) -> None:
    """One segmented option on the settings screen. A championship round locks every
    row but the difficulty."""
    if ctx.get(RacePlan).championship and row != "difficulty":
        return
    if row == "laps":
        set_laps(ctx, int(value))
    elif row == "opponents":
        set_opponents(ctx, int(value))
    elif row == "difficulty":
        pick_difficulty(ctx, ctx.content(DifficultyDef).get(value))
    elif row == "time_of_day":
        pick_time(ctx, ctx.content(TimeOfDayDef).get(value))
    elif row == "weather":
        pick_weather(ctx, ctx.content(WeatherDef).get(value))
