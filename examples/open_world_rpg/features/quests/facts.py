"""Story facts. Each chapter's last step sets its `_done` fact; the .yarn files read them as `$<key>`."""

from parallax.story import fact

WelcomeHeroDone = fact("welcome_hero_done", False)
GoblinMenaceDone = fact("goblin_menace_done", False)
RestlessBarrowDone = fact("restless_barrow_done", False)
ShamanCircleDone = fact("shaman_circle_done", False)
IronholdDone = fact("ironhold_done", False)
ShadowDungeonDone = fact("shadow_dungeon_done", False)
