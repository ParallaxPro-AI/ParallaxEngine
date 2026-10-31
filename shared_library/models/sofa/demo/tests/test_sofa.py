from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sofa: the prefab spawns and its model's controls work")
async def test_sofa(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sofa, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("footrest", 39.0)
    assert abs(model.joint("footrest") - 39.0) < 1e-3
    model.set_option("layout", "two_seat")
    assert model.option("layout") == "two_seat"
    assert model.socket_position("socket_seat_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
