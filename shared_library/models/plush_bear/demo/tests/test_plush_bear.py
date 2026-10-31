from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plush_bear: the prefab spawns and its model's controls work")
async def test_plush_bear(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plush_bear, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_nod", 0.0)
    assert abs(model.joint("head_nod") - 0.0) < 1e-3
    model.set_option("fur", "coral")
    assert model.option("fur") == "coral"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
