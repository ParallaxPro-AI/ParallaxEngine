from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mech_hangar_gantry: the prefab spawns and its model's controls work")
async def test_mech_hangar_gantry(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mech_hangar_gantry, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trolley", 0.0)
    assert abs(model.joint("trolley") - 0.0) < 1e-3
    model.set_option("paint", "grey")
    assert model.option("paint") == "grey"
    assert model.socket_position("mech_bay").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
