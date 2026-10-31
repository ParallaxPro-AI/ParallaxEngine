from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("billiard_cue_rack: the prefab spawns and its model's controls work")
async def test_billiard_cue_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.billiard_cue_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cue_0", 0.1)
    assert abs(model.joint("cue_0") - 0.1) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    assert model.socket_position("cue_slot_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
