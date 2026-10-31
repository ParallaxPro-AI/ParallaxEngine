from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("command_table_map: the prefab spawns and its model's controls work")
async def test_command_table_map(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.command_table_map, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "tan")
    assert model.option("frame") == "tan"
    assert model.socket_position("brief_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
