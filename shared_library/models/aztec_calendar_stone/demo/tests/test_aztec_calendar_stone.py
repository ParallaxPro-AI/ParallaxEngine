from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("aztec_calendar_stone: the prefab spawns and its model's controls work")
async def test_aztec_calendar_stone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.aztec_calendar_stone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("paint", "bare")
    assert model.option("paint") == "bare"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
