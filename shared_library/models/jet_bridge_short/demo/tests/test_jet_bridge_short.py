from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jet_bridge_short: the prefab spawns and its model's controls work")
async def test_jet_bridge_short(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jet_bridge_short, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab", 0.0)
    assert abs(model.joint("cab") - 0.0) < 1e-3
    model.set_option("cladding", "grey")
    assert model.option("cladding") == "grey"
    assert model.socket_position("socket_aircraft_door").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
