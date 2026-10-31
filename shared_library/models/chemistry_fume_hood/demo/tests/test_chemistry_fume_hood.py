from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chemistry_fume_hood: the prefab spawns and its model's controls work")
async def test_chemistry_fume_hood(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chemistry_fume_hood, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_door_l", 52.5)
    assert abs(model.joint("cab_door_l") - 52.5) < 1e-3
    model.set_option("contents", "empty")
    assert model.option("contents") == "empty"
    assert model.socket_position("work_surface").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
