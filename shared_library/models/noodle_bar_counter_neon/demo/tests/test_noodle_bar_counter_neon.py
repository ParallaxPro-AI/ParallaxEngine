from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("noodle_bar_counter_neon: the prefab spawns and its model's controls work")
async def test_noodle_bar_counter_neon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.noodle_bar_counter_neon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("neon_a", "magenta")
    assert model.option("neon_a") == "magenta"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
