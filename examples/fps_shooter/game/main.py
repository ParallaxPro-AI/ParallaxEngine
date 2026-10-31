"""Dustline: an offline deathmatch gauntlet against AI bots."""

from parallax import Game
from parallax.plugins import characters, combat, hud, interaction, nav, physics3d, procgen, terrain, viewmodel
from project import Scenes

from game.damage import escalation, plating
from game.actions import FpsControls
from game.layers import Layers
from game.systems.respawns import Respawns
from game.systems.rounds import Rounds
from game.systems.scoring import Scoring
from game.systems.hit_numbers import HitNumbers

game = Game(
    id="fps_shooter",
    title="Dustline: FPS Deathmatch",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        physics3d(layers=Layers),
        terrain(),
        procgen(),
        characters(),
        combat(modifiers=[escalation, plating]),
        nav(agent_radius=0.5),
        hud(),
        interaction(action=FpsControls.interact),
        viewmodel(),
    ],
    systems=[Scoring, Rounds, Respawns, HitNumbers],
)
