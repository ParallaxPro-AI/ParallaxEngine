from parallax.hud import Minimap
from parallax.test import playtest
from project import Placed, Scenes

from game.lib.map_screen import MapControls, MapCorner, MapScreen


@playtest("the restyled minimap shows the corner view with the HUD kit's state")
async def test_corner(game):
    await game.start(scene=Scenes.island)
    await game.advance(frames=2)
    assert game.is_open(MapCorner) and not game.is_open(MapScreen)
    state = game.panel_state(MapCorner)
    assert state["shown"]
    assert len(state["icons"]) >= 1
    minimap = game.world.placed(Placed.explorer).get(Minimap)
    assert minimap.range == 40 and minimap.rotate


@playtest("holding the map key zooms out north-up; letting go comes back")
async def test_hold(game):
    await game.start(scene=Scenes.island)
    minimap = game.world.placed(Placed.explorer).get(Minimap)
    await game.hold(MapControls.map)
    await game.advance(frames=2)
    assert minimap.range == 250 and not minimap.rotate
    assert game.is_open(MapScreen) and not game.is_open(MapCorner)
    assert game.panel_state(MapScreen)["shown"]
    await game.release(MapControls.map)
    await game.advance(frames=2)
    assert minimap.range == 40 and minimap.rotate
    assert game.is_open(MapCorner) and not game.is_open(MapScreen)
