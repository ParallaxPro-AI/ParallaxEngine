from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("convenience_store: the prefab spawns and its model's controls work")
async def test_convenience_store(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.convenience_store, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("display_chiller_leaf_0_0", 47.5)
    assert abs(model.joint("display_chiller_leaf_0_0") - 47.5) < 1e-3
    model.set_option("precast_colour", "buff_precast")
    assert model.option("precast_colour") == "buff_precast"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
