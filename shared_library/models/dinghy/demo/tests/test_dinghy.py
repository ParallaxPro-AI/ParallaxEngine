from parallax import Model, vec3
from parallax.physics import Rigidbody
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dinghy: the prefab spawns and its model's controls work")
async def test_dinghy(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dinghy, at=vec3(0, 1.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 7.2
    await game.advance(seconds=4)
    assert thing.transform.position.y < 1.0
    assert thing.get(Rigidbody).velocity.length() < 0.5
