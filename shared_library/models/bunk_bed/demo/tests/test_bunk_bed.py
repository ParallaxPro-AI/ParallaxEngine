from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bunk_bed: the prefab spawns and its model's controls work")
async def test_bunk_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bunk_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_foot", 0.21)
    assert abs(model.joint("drawer_foot") - 0.21) < 1e-3
    model.set_option("finish", "walnut")
    assert model.option("finish") == "walnut"
    assert model.socket_position("socket_bunk_lower").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
