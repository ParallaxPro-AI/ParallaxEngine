from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("window_boards: the prefab spawns and its model's controls work")
async def test_window_boards(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.window_boards, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("coverage", "none")
    assert model.option("coverage") == "none"
    assert model.socket_position("gap").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
