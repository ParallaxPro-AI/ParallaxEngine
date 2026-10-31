from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("blast_door: the prefab spawns and its model's controls work")
async def test_blast_door(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.blast_door, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_left", 0.21)
    assert abs(model.joint("leaf_left") - 0.21) < 1e-3
    model.set_option("condition", "battle_worn")
    assert model.option("condition") == "battle_worn"
    assert model.socket_position("socket_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
