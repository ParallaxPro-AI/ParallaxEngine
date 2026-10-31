from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("vcr_vhs: the prefab spawns and its model's controls work")
async def test_vcr_vhs(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.vcr_vhs, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("slot_flap", 40.0)
    assert abs(model.joint("slot_flap") - 40.0) < 1e-3
    model.set_option("tape", "none")
    assert model.option("tape") == "none"
    assert model.socket_position("socket_slot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
