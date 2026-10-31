from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("stealth_bomber: the prefab spawns and its model's controls work")
async def test_stealth_bomber(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.stealth_bomber, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bay_door_l", 47.5)
    assert abs(model.joint("bay_door_l") - 47.5) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
