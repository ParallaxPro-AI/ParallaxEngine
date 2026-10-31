from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mech_suit: the prefab spawns and its model's controls work")
async def test_mech_suit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mech_suit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hip_l", 0.0)
    assert abs(model.joint("hip_l") - 0.0) < 1e-3
    model.set_option("loadout", "missiles")
    assert model.option("loadout") == "missiles"
    assert model.socket_position("socket_pilot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
