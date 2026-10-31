from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tool_pegboard: the prefab spawns and its model's controls work")
async def test_tool_pegboard(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tool_pegboard, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("board", "brown")
    assert model.option("board") == "brown"
    assert model.socket_position("socket_free_hook_area").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
