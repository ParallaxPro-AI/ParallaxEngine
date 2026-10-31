from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("radiator: the prefab spawns and its model's controls work")
async def test_radiator(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.radiator, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("thermostat_valve", 135.0)
    assert abs(model.joint("thermostat_valve") - 135.0) < 1e-3
    model.set_option("style", "column")
    assert model.option("style") == "column"
    assert model.socket_position("socket_wall").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
