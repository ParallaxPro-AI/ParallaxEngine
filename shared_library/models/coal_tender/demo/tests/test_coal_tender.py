from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coal_tender: the prefab spawns and its model's controls work")
async def test_coal_tender(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coal_tender, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("locker_lid_l", 50.0)
    assert abs(model.joint("locker_lid_l") - 50.0) < 1e-3
    model.set_option("livery", "black")
    assert model.option("livery") == "black"
    assert model.socket_position("socket_coupler_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
