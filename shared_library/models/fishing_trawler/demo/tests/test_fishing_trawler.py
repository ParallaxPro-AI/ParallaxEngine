from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fishing_trawler: the prefab spawns and its model's controls work")
async def test_fishing_trawler(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fishing_trawler, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 50.0)
    assert abs(model.joint("door_l") - 50.0) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 24.2
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
