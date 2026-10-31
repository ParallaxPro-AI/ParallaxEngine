from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("treasure_map_table: the prefab spawns and its model's controls work")
async def test_treasure_map_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.treasure_map_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.15)
    assert abs(model.joint("drawer") - 0.15) < 1e-3
    model.set_option("frame", "oak")
    assert model.option("frame") == "oak"
    assert model.socket_position("socket_map").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
