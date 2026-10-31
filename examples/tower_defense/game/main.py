"""Tower Siege: hold four battlefields against a marching horde."""

from parallax import Game
from parallax.plugins import combat, hud
from project import Scenes

from game.damage import venom_pierces
from game.systems.building import Building
from game.systems.outcome import Outcome
from game.systems.treasury import Treasury
from game.systems.waves import Waves

game = Game(
    id="tower_defense",
    title="Tower Siege",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.level_select,
    plugins=[combat(modifiers=[venom_pierces], min_damage=1), hud()],
    systems=[Building, Waves, Treasury, Outcome],
)
