from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scaffold_tower_mobile: the prefab spawns and its model's controls work")
async def test_scaffold_tower_mobile(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scaffold_tower_mobile, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trapdoor", 55.0)
    assert abs(model.joint("trapdoor") - 55.0) < 1e-3
    model.set_option("stabilisers", "none")
    assert model.option("stabilisers") == "none"
    assert model.socket_position("socket_platform").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
