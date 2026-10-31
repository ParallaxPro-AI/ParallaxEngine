from parallax.test import playtest
from project import Scenes

from game.main import ThemedCard


@playtest("a panel linking the library theme opens with its state")
async def test_card(game):
    await game.start(scene=Scenes.main)
    await game.advance(frames=1)
    assert game.is_open(ThemedCard)
    assert game.panel_state(ThemedCard)["value"] == 1250
