"""Fist Circuit: a one-on-one fighter with a five-rival ladder, training and practice."""

from parallax import Game
from parallax.plugins import characters, combat, physics3d
from project import Scenes

from game.components import Layers
from game.damage import only_the_circuit_knocks_out, rival_difficulty
from game.systems.career import CareerRecords
from game.systems.exchange import Exchange
from game.systems.practice import Practice
from game.systems.round_flow import RoundFlow
from game.systems.run_metrics import RunMetrics
from game.systems.training import Training

game = Game(
    id="fighting_game",
    title="Fist Circuit",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.arena,
    plugins=[
        physics3d(gravity=-22, layers=Layers),
        characters(),
        combat(modifiers=[rival_difficulty, only_the_circuit_knocks_out]),
    ],
    systems=[Exchange, RunMetrics, Training, Practice, RoundFlow, CareerRecords],
)
