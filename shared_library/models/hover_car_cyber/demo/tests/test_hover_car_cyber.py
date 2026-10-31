from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hover_car_cyber: the prefab spawns and its model's controls work")
async def test_hover_car_cyber(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hover_car_cyber, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("canopy", 21.0)
    assert abs(model.joint("canopy") - 21.0) < 1e-3
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
