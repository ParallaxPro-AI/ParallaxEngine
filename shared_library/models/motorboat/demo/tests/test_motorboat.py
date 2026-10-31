from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("motorboat: the prefab spawns and its model's controls work")
async def test_motorboat(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.motorboat, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("windshield", 41.0)
    assert abs(model.joint("windshield") - 41.0) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
