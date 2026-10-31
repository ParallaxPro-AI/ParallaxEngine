from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("socket_set_case: the prefab spawns and its model's controls work")
async def test_socket_set_case(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.socket_set_case, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 52.5)
    assert abs(model.joint("lid") - 52.5) < 1e-3
    model.set_option("case", "blue")
    assert model.option("case") == "blue"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
