from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sawhorse: the prefab spawns and its model's controls work")
async def test_sawhorse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sawhorse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold", 20.0)
    assert abs(model.joint("fold") - 20.0) < 1e-3
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 2.18
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
