from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("apartment_midrise: the prefab spawns and its model's controls work")
async def test_apartment_midrise(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.apartment_midrise, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("entrance", 47.5)
    assert abs(model.joint("entrance") - 47.5) < 1e-3
    model.set_option("facade", "sand_render")
    assert model.option("facade") == "sand_render"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
