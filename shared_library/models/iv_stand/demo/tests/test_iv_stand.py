from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("iv_stand: the prefab spawns and its model's controls work")
async def test_iv_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.iv_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("height", 0.25)
    assert abs(model.joint("height") - 0.25) < 1e-3
    assert model.socket_position("socket_hook_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
