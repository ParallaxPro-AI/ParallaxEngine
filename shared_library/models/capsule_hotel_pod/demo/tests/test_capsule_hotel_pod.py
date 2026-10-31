from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("capsule_hotel_pod: the prefab spawns and its model's controls work")
async def test_capsule_hotel_pod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.capsule_hotel_pod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pod0_hatch", 41.0)
    assert abs(model.joint("pod0_hatch") - 41.0) < 1e-3
    model.set_option("glow", "magenta")
    assert model.option("glow") == "magenta"
    assert model.socket_position("socket_sleep_lower").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
