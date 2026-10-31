from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("aircraft_hangar: the prefab spawns and its model's controls work")
async def test_aircraft_hangar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.aircraft_hangar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l_outer", 3.25)
    assert abs(model.joint("door_l_outer") - 3.25) < 1e-3
    model.set_option("door_colour", "green")
    assert model.option("door_colour") == "green"
    assert model.socket_position("socket_aircraft").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
