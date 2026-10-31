from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wet_floor_sign: the prefab spawns and its model's controls work")
async def test_wet_floor_sign(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wet_floor_sign, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold", 14.0)
    assert abs(model.joint("fold") - 14.0) < 1e-3
    model.set_option("colour", "orange")
    assert model.option("colour") == "orange"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
