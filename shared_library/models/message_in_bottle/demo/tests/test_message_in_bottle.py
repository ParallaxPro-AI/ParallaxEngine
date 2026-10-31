from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("message_in_bottle: the prefab spawns and its model's controls work")
async def test_message_in_bottle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.message_in_bottle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("weathering", "clean")
    assert model.option("weathering") == "clean"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
