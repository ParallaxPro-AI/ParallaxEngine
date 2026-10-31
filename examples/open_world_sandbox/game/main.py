"""Sunset Bay — an open-world crime sandbox.

Steal cars, draw a wanted level, lose the police, run jobs for Mara and Mike, walk into the
safehouse, and take photographs of the mess you made.
"""

from parallax import Game, plugins
from project import Scenes

from features.city_life.feature import city_life
from features.driving.feature import driving
from features.interiors.feature import interiors
from features.missions.feature import missions
from features.on_foot.feature import on_foot
from features.phone.feature import phone
from features.police.feature import police
from game.lib.map_screen import MapZoom
from game.lib.radial_menu import RadialSelection

game = Game(
    id="sunset_bay",
    title="Sunset Bay",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    plugins=[
        plugins.physics3d(),
        plugins.terrain(),
        plugins.city(),
        plugins.characters(),
        plugins.vehicles(),
        plugins.nav(agent_radius=0.35),
        plugins.combat(),
        plugins.story(),
        plugins.save(),
        plugins.weather(),
        plugins.hud(),
    ],
    systems=[MapZoom, RadialSelection],
    features=[interiors, phone, on_foot, driving, city_life, police, missions],
    save_version=3,
)
