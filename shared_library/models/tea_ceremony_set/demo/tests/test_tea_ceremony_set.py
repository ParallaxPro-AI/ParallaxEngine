from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tea_ceremony_set: the prefab spawns and its model's controls work")
async def test_tea_ceremony_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tea_ceremony_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("kettle_lid", 0.03)
    assert abs(model.joint("kettle_lid") - 0.03) < 1e-3
    assert model.socket_position("bowl_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
