from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chinese_lion_statue: the prefab spawns and its model's controls work")
async def test_chinese_lion_statue(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chinese_lion_statue, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("gender", "female")
    assert model.option("gender") == "female"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
