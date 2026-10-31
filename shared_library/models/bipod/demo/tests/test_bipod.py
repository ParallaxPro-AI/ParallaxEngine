from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bipod: the prefab spawns and its model's controls work")
async def test_bipod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bipod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leg_l", 45.0)
    assert abs(model.joint("leg_l") - 45.0) < 1e-3
    assert model.socket_position("socket_mount").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
