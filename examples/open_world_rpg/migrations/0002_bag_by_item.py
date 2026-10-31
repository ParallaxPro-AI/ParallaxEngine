"""Save version 2: the bag keys every item by id instead of one counter per potion."""

from parallax import SaveData, migration


@migration(from_version=1, to_version=2)
def bag_by_item(save: SaveData) -> None:
    bag = save.resources["bag"]
    bag["items"] = {
        "health_potion": bag.pop("health_potions", 0),
        "mana_potion": bag.pop("mana_potions", 0),
    }
