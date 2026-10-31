from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("police_suv: the prefab spawns and its model's controls work")
async def test_police_suv(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.police_suv, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_f_l", 34.0)
    assert abs(model.joint("door_f_l") - 34.0) < 1e-3
    model.set_option("kit", "rural")
    assert model.option("kit") == "rural"
    await game.advance(seconds=1)
