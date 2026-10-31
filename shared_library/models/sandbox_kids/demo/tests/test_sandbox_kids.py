from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sandbox_kids: the prefab spawns and its model's controls work")
async def test_sandbox_kids(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sandbox_kids, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid_l", 51.0)
    assert abs(model.joint("lid_l") - 51.0) < 1e-3
    model.set_option("finish", "red")
    assert model.option("finish") == "red"
    assert model.socket_position("seat_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
