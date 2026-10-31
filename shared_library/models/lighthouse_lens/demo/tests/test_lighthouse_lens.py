from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lighthouse_lens: the prefab spawns and its model's controls work")
async def test_lighthouse_lens(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lighthouse_lens, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("clock_door", 55.0)
    assert abs(model.joint("clock_door") - 55.0) < 1e-3
    model.set_option("pedestal", "green")
    assert model.option("pedestal") == "green"
    assert model.socket_position("keeper").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
