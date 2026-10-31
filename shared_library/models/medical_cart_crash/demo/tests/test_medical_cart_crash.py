from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("medical_cart_crash: the prefab spawns and its model's controls work")
async def test_medical_cart_crash(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.medical_cart_crash, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_0", 0.19)
    assert abs(model.joint("drawer_0") - 0.19) < 1e-3
    model.set_option("body", "blue")
    assert model.option("body") == "blue"
    assert model.socket_position("top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
