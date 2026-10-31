from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("overhead_crane_rail: the prefab spawns and its model's controls work")
async def test_overhead_crane_rail(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.overhead_crane_rail, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("ends", "open")
    assert model.option("ends") == "open"
    assert model.socket_position("end_neg").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
