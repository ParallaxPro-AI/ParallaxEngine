from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dungeon_doorway: the prefab spawns and its model's controls work")
async def test_dungeon_doorway(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dungeon_doorway, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_leaf", 47.5)
    assert abs(model.joint("door_leaf") - 47.5) < 1e-3
    model.set_option("stone", "dark")
    assert model.option("stone") == "dark"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
