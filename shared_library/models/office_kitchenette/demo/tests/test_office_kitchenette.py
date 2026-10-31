from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("office_kitchenette: the prefab spawns and its model's controls work")
async def test_office_kitchenette(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.office_kitchenette, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sink_door_l", 50.0)
    assert abs(model.joint("sink_door_l") - 50.0) < 1e-3
    model.set_option("fronts", "sage")
    assert model.option("fronts") == "sage"
    assert model.socket_position("socket_counter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
