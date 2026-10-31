from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ev_charging_station: the prefab spawns and its model's controls work")
async def test_ev_charging_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ev_charging_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("accent", "green")
    assert model.option("accent") == "green"
    assert model.socket_position("socket_plug_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
