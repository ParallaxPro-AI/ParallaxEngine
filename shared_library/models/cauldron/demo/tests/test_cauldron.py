from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cauldron: the prefab spawns and its model's controls work")
async def test_cauldron(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cauldron, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tip", 15.0)
    assert abs(model.joint("tip") - 15.0) < 1e-3
    assert model.socket_position("socket_rim_front").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
