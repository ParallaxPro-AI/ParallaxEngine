from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("info_totem: the prefab spawns and its model's controls work")
async def test_info_totem(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.info_totem, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("service_door", 55.0)
    assert abs(model.joint("service_door") - 55.0) < 1e-3
    model.set_option("colour", "white")
    assert model.option("colour") == "white"
    assert model.socket_position("socket_user").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
