from parallax import Game
from parallax.plugins import characters, hud, physics3d, save, terrain, vehicles, water, weather
from project import Scenes

from game.systems.airframes import Airframes
from game.systems.contract_clock import ContractClock
from game.systems.contracts import Contracts
from game.systems.depot_office import DepotOffice
from game.systems.feed_clock import FeedClock
from game.systems.landings import Landings
from game.systems.payoff import Payoff

game = Game(
    id="cargo_plane",
    title="Sky Freight",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(), water(), characters(), vehicles(), save(), hud(), terrain(), weather()],
    systems=[DepotOffice, Landings, Contracts, ContractClock, Airframes, Payoff, FeedClock],
    start_scene=Scenes.title,
)
