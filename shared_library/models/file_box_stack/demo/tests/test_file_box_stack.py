from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("file_box_stack: the prefab spawns and its model's controls work")
async def test_file_box_stack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.file_box_stack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("box_a2_lid", 0.07)
    assert abs(model.joint("box_a2_lid") - 0.07) < 1e-3
    model.set_option("count", "three")
    assert model.option("count") == "three"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
