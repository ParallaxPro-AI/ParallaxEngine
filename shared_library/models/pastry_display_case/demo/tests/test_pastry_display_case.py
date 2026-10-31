from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pastry_display_case: the prefab spawns and its model's controls work")
async def test_pastry_display_case(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pastry_display_case, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 0.25)
    assert abs(model.joint("door_l") - 0.25) < 1e-3
    model.set_option("body", "black")
    assert model.option("body") == "black"
    assert model.socket_position("top_socket").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
