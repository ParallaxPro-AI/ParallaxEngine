from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spotlight_followspot: the prefab spawns and its model's controls work")
async def test_spotlight_followspot(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spotlight_followspot, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tilt", 5.0)
    assert abs(model.joint("tilt") - 5.0) < 1e-3
    model.set_option("gel", "amber")
    assert model.option("gel") == "amber"
    assert model.socket_position("operator").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
