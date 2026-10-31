from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("welding_rig: the prefab spawns and its model's controls work")
async def test_welding_rig(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.welding_rig, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wire_door", 50.0)
    assert abs(model.joint("wire_door") - 50.0) < 1e-3
    model.set_option("paint", "red")
    assert model.option("paint") == "red"
    assert model.socket_position("torch_tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
