from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gravity_lift: the prefab spawns and its model's controls work")
async def test_gravity_lift(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gravity_lift, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lift_ring_0", 1.65)
    assert abs(model.joint("lift_ring_0") - 1.65) < 1e-3
    model.set_option("field_colour", "violet")
    assert model.option("field_colour") == "violet"
    assert model.socket_position("launch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
