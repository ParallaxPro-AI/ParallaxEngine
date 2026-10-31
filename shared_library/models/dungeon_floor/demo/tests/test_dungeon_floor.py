from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dungeon_floor: the prefab spawns and its model's controls work")
async def test_dungeon_floor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dungeon_floor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("detail", "drain")
    assert model.option("detail") == "drain"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
