from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bunting_line: the prefab spawns and its model's controls work")
async def test_bunting_line(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bunting_line, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("mounts", "hooks")
    assert model.option("mounts") == "hooks"
    assert model.socket_position("socket_end_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
