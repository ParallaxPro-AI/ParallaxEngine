from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("snake_enemy: the prefab spawns and its model's controls work")
async def test_snake_enemy(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.snake_enemy, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("neck", 27.0)
    assert abs(model.joint("neck") - 27.0) < 1e-3
    model.set_option("skin", "green")
    assert model.option("skin") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
