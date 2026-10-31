from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("train_set_wooden: the prefab spawns and its model's controls work")
async def test_train_set_wooden(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.train_set_wooden, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("engine", "green")
    assert model.option("engine") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
