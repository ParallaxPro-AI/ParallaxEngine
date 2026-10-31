from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rail_tank_car: the prefab spawns and its model's controls work")
async def test_rail_tank_car(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rail_tank_car, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("manway_hatch", 57.5)
    assert abs(model.joint("manway_hatch") - 57.5) < 1e-3
    model.set_option("paint", "white")
    assert model.option("paint") == "white"
    assert model.socket_position("socket_coupler_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
