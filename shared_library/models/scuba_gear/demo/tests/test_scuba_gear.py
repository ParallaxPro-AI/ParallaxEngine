from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scuba_gear: the prefab spawns and its model's controls work")
async def test_scuba_gear(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scuba_gear, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("trim", "yellow")
    assert model.option("trim") == "yellow"
    assert model.socket_position("socket_valve").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
