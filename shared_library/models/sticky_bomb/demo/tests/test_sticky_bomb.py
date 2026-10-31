from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sticky_bomb: the prefab spawns and its model's controls work")
async def test_sticky_bomb(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sticky_bomb, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arming_dial", 90.0)
    assert abs(model.joint("arming_dial") - 90.0) < 1e-3
    assert model.socket_position("blast").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
