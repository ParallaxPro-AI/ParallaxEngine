from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("anti_aircraft_gun: the prefab spawns and its model's controls work")
async def test_anti_aircraft_gun(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.anti_aircraft_gun, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("guns", 37.5)
    assert abs(model.joint("guns") - 37.5) < 1e-3
    model.set_option("paint", "desert")
    assert model.option("paint") == "desert"
    assert model.socket_position("seat_gunner_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
