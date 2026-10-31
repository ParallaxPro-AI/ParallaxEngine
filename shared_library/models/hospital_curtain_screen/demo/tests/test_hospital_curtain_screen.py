from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hospital_curtain_screen: the prefab spawns and its model's controls work")
async def test_hospital_curtain_screen(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hospital_curtain_screen, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wing_l", 85.0)
    assert abs(model.joint("wing_l") - 85.0) < 1e-3
    model.set_option("fabric", "green")
    assert model.option("fabric") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
