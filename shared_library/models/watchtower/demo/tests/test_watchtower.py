from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("watchtower: the prefab spawns and its model's controls work")
async def test_watchtower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.watchtower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bell", 14.0)
    assert abs(model.joint("bell") - 14.0) < 1e-3
    model.set_option("roofing", "planks")
    assert model.option("roofing") == "planks"
    assert model.socket_position("lookout").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
