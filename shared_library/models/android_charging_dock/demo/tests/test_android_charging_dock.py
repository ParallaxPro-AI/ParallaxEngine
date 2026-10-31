from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("android_charging_dock: the prefab spawns and its model's controls work")
async def test_android_charging_dock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.android_charging_dock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("clamp_l", 45.0)
    assert abs(model.joint("clamp_l") - 45.0) < 1e-3
    model.set_option("glow", "green")
    assert model.option("glow") == "green"
    assert model.socket_position("socket_occupant").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
