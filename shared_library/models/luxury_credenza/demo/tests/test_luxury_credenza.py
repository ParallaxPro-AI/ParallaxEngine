from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luxury_credenza: the prefab spawns and its model's controls work")
async def test_luxury_credenza(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luxury_credenza, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_0_hinge", 52.5)
    assert abs(model.joint("door_0_hinge") - 52.5) < 1e-3
    model.set_option("styling", "bare")
    assert model.option("styling") == "bare"
    assert model.socket_position("surface_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
