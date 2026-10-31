from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("apartment_lowrise: the prefab spawns and its model's controls work")
async def test_apartment_lowrise(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.apartment_lowrise, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("entrance", 47.5)
    assert abs(model.joint("entrance") - 47.5) < 1e-3
    model.set_option("facade", "buff_brick")
    assert model.option("facade") == "buff_brick"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
