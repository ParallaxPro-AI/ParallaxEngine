from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("accordion: the prefab spawns and its model's controls work")
async def test_accordion(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.accordion, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bellows", 0.07)
    assert abs(model.joint("bellows") - 0.07) < 1e-3
    assert model.socket_position("socket_strap").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
