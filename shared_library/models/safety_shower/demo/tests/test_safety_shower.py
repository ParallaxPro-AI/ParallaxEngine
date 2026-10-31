from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("safety_shower: the prefab spawns and its model's controls work")
async def test_safety_shower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.safety_shower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pull_rod", 0.05)
    assert abs(model.joint("pull_rod") - 0.05) < 1e-3
    model.set_option("finish", "stainless")
    assert model.option("finish") == "stainless"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
