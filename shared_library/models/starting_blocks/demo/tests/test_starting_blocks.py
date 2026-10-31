from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("starting_blocks: the prefab spawns and its model's controls work")
async def test_starting_blocks(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.starting_blocks, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carriage_front", 0.03)
    assert abs(model.joint("carriage_front") - 0.03) < 1e-3
    model.set_option("pads", "blue")
    assert model.option("pads") == "blue"
    assert model.socket_position("socket_front_foot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
