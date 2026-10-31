from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("washer_dryer_stack: the prefab spawns and its model's controls work")
async def test_washer_dryer_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.washer_dryer_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("washer_door", 52.5)
    assert abs(model.joint("washer_door") - 52.5) < 1e-3
    model.set_option("finish", "graphite")
    assert model.option("finish") == "graphite"
    assert model.socket_position("socket_washer_drum").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
