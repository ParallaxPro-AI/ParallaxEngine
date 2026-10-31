from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tatami_platform: the prefab spawns and its model's controls work")
async def test_tatami_platform(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tatami_platform, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_l", 0.26)
    assert abs(model.joint("drawer_l") - 0.26) < 1e-3
    model.set_option("heri", "green")
    assert model.option("heri") == "green"
    assert model.socket_position("seat_1").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
