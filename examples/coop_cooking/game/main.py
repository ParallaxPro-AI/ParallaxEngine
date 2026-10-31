from parallax import Game
from parallax.plugins import characters, local_players, physics3d, procgen
from project import Prefabs, Scenes

from game.actions import ChefControls, SecondChefControls
from game.systems.guide import Guide
from game.systems.order_rail import OrderRail
from game.systems.service_clock import ServiceClock
from game.systems.stoves import Stoves

game = Game(
    id="coop_cooking",
    title="Kitchen Rush",
    sdk="1.0",
    mode="3d",
    plugins=[
        physics3d(),
        characters(),
        procgen(),
        local_players(
            seats=2,
            player_prefab=Prefabs.chef,
            controls=[ChefControls, SecondChefControls],
            camera_prefab=Prefabs.chef_camera,
            split_screen="vertical",
        ),
    ],
    systems=[OrderRail, Stoves, Guide, ServiceClock],
    start_scene=Scenes.diner,
)
