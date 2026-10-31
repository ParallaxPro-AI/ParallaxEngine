from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grenade: the prefab spawns and its model's controls work")
async def test_grenade(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grenade, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pin", 0.0275)
    assert abs(model.joint("pin") - 0.0275) < 1e-3
    model.set_option("type", "smoke")
    assert model.option("type") == "smoke"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
