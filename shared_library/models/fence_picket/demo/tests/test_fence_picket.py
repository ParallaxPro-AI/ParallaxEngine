from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fence_picket: the prefab spawns and its model's controls work")
async def test_fence_picket(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fence_picket, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("end_post", "off")
    assert model.option("end_post") == "off"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
