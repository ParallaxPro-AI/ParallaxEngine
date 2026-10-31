from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("raft: the prefab spawns and its model's controls work")
async def test_raft(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.raft, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sweep", 0.0)
    assert abs(model.joint("sweep") - 0.0) < 1e-3
    model.set_option("rig", "bare")
    assert model.option("rig") == "bare"
    assert model.socket_position("waterline").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
