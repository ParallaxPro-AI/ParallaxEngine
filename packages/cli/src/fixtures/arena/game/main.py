from parallax import Game
from parallax.plugins import net
from project import Prefabs, Scenes

game = Game(
    id="arena",
    title="Arena",
    sdk="1.0",
    mode="2d",
    plugins=[net(max_players=4, player_prefab=Prefabs.player)],
    start_scene=Scenes.main,
)
