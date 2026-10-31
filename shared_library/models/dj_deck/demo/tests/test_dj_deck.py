from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dj_deck: the prefab spawns and its model's controls work")
async def test_dj_deck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dj_deck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deck_l_tonearm", 12.0)
    assert abs(model.joint("deck_l_tonearm") - 12.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
