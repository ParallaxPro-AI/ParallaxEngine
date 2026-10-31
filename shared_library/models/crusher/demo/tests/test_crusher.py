from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crusher: the prefab spawns and its model's controls work")
async def test_crusher(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crusher, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crush_l", 0.06)
    assert abs(model.joint("crush_l") - 0.06) < 1e-3
    assert model.socket_position("socket_crush").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
