from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("toy_train_set: the prefab spawns and its model's controls work")
async def test_toy_train_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.toy_train_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("engine_paint", "blue")
    assert model.option("engine_paint") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
