from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trumpet: the prefab spawns and its model's controls work")
async def test_trumpet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trumpet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tuning_slide", 0.0175)
    assert abs(model.joint("tuning_slide") - 0.0175) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
