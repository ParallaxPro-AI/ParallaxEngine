from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("checkpoint_post: the prefab spawns and its model's controls work")
async def test_checkpoint_post(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.checkpoint_post, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("booth_door", 50.0)
    assert abs(model.joint("booth_door") - 50.0) < 1e-3
    assert model.socket_position("sentry").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
