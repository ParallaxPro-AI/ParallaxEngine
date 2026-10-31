from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wyvern: the prefab spawns and its model's controls work")
async def test_wyvern(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wyvern, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head", 0.0)
    assert abs(model.joint("head") - 0.0) < 1e-3
    model.set_option("hide", "crimson")
    assert model.option("hide") == "crimson"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
