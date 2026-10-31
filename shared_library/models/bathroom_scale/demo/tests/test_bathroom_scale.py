from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bathroom_scale: the prefab spawns and its model's controls work")
async def test_bathroom_scale(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bathroom_scale, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("platform", 0.0015)
    assert abs(model.joint("platform") - 0.0015) < 1e-3
    model.set_option("glass", "white")
    assert model.option("glass") == "white"
    assert model.socket_position("socket_stand").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
