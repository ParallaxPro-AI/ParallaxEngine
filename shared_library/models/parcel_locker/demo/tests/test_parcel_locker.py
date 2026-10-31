from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("parcel_locker: the prefab spawns and its model's controls work")
async def test_parcel_locker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.parcel_locker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("c0_door_0", 52.5)
    assert abs(model.joint("c0_door_0") - 52.5) < 1e-3
    model.set_option("colour", "red")
    assert model.option("colour") == "red"
    assert model.socket_position("socket_screen").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
