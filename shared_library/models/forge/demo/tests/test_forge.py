from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("forge: the prefab spawns and its model's controls work")
async def test_forge(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.forge, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bellows", 12.5)
    assert abs(model.joint("bellows") - 12.5) < 1e-3
    assert model.socket_position("socket_fire").distance_to(thing.transform.position) < 5.18
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
