from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hopscotch_numeral: the prefab spawns and its model's controls work")
async def test_hopscotch_numeral(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hopscotch_numeral, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("digit", "2")
    assert model.option("digit") == "2"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
