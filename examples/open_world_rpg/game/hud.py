"""The HUD: the template's lantern-glass layout (ui/hud.html), bound to state from every feature.

The panel has no script: every width, turn, class and line it shows is computed here.
"""

import math

from parallax import Context, Entity, Panel, open_panel, ui, vec2
from parallax.combat import Health
from parallax.hud import Nameplate, NameplatesPanel
from project import Content, Placed, Text

from features.combat.feature import AbilityDef, Boss, HeroHurt, Hostile, Spellbook, Threat
from features.companion.feature import Companion
from features.hero.feature import Dodge, Hero, HeroCurve, Mana, Progression, xp_to_next
from features.inventory.feature import Bag, GearPanel, Purse
from features.quests.feature import Chapter, Doom, Focus, JournalPanel, Merchant, objective_line, rift_running
from game.feed import Feed, Kind
from game.reading import Reading
from game.ui import PauseMenu

# How long the template's HUD shows each piece of news (seconds).
TOAST_FOR, TOAST_FADES_AT, TOASTS_SHOWN = 3.55, 3.2, 3
LEVEL_FOR, HINT_FOR = 3.5, 2.5


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """Vitals and purse; the objective card with its bearing arrow; the boss bar and the rift
    countdown; toasts, the level banner and the combat hint; the talk prompt; the ability dock; the
    journal button, the gear pill and the touch pause plate."""

    actions = {"journal": open_panel(JournalPanel), "gear": open_panel(GearPanel), "pause": open_panel(PauseMenu)}

    def state(self, ctx):
        hero = ctx.world.query(tagged=Hero).single()
        return {
            "scale": "1.18" if ctx.get(Reading).large else "1",
            "vitals": vitals(ctx, hero),
            "pet": pet(ctx),
            "quest": quest(ctx),
            "boss": boss(ctx),
            "rift": rift(ctx),
            "prompt": prompt(ctx),
            "dock": dock(ctx, hero),
            **news(ctx),
        }


@ui("nameplates", html="ui/nameplates.html")
class SundermerePlates(NameplatesPanel):
    """The enemy bars over heads, restyled to the template's gilt-hairlined red bar."""


def percent(part: float, whole: float) -> str:
    return f"{max(0.0, min(100.0, 100 * part / whole if whole else 0)):.1f}%"


def vitals(ctx: Context, hero: Entity) -> dict[str, object]:
    health, mana = hero.get(Health), hero.get(Mana)
    progress = ctx.get(Progression)
    potions = potion_count(ctx)
    xp = min(100, math.floor(100 * progress.xp / xp_to_next(ctx.config(HeroCurve), progress.level)))
    return {
        "level": progress.level,
        "health": max(0, math.ceil(health.current)), "health_max": round(health.max),
        "health_width": percent(health.current, health.max),
        "mana": max(0, math.floor(mana.current)), "mana_max": round(mana.max),
        "mana_width": percent(mana.current, mana.max),
        "xp_width": f"{xp}%",
        "low": 0 < health.current < health.max * 0.25,
        # The template's screen juice: a coral edge flash on every hit (0.6, fading over 0.25 s) and a crimson edge
        # pulsing every 1.2 s at or under 30 % health.
        "hurt": f"{0.6 * max(0.0, 1 - (ctx.time.now - ctx.get(HeroHurt).at) / 0.25):.2f}",
        "faint": 0 < health.current <= health.max * 0.3,
        "gold": ctx.get(Purse).gold,
        "potions": potions,
        "potion_word": ctx.text(Text.potion_one if potions == 1 else Text.potion_many),
    }


def potion_count(ctx: Context) -> int:
    items = ctx.get(Bag).items
    return items.get(Content.item.health_potion, 0) + items.get(Content.item.mana_potion, 0)


def pet(ctx: Context) -> dict[str, object]:
    row = ctx.world.query(Health, Companion).first()
    if row is None:
        return {"shown": False}
    _, health, companion = row
    name = ctx.text(companion.name).upper()
    if health.dead:
        return {"shown": True, "down": True, "label": f"{name} DOWN", "width": f"{100 * companion.revive.progress:.1f}%",
                "value": f"{math.ceil(companion.revive.remaining)}s"}
    return {"shown": True, "down": False, "label": name, "width": percent(health.current, health.max),
            "value": str(math.ceil(health.current))}


def quest(ctx: Context) -> dict[str, object]:
    chapters = ctx.content(Chapter)
    done = len(ctx.story.quests("completed"))
    active = ctx.story.quests("active")
    current = active[0] if active else None
    bearing = arrow(ctx)
    return {
        "chapter": f"{min(len(chapters), done + 1):02d}",
        "of": f"/ {len(chapters):02d}",
        "title": ctx.text(current.data.title) if current is not None else "",
        "text": objective_line(ctx, current) if current is not None else "",
        "safe": bearing is None,
        "turn": f"rotate({bearing[0]:.1f}deg)" if bearing is not None else "",
        "distance": bearing[1] if bearing is not None else 0,
    }


# QuestStep.marker is a placed id as a plain string, and nothing turns a string into an EntityRef,
# so the HUD names the beacons it can point at (NOTES.md, "marker refs").
MARKERS = {
    "beacon_elder": Placed.beacon_elder, "beacon_caravan": Placed.beacon_caravan, "beacon_rowan": Placed.beacon_rowan,
    "beacon_channelers": Placed.beacon_channelers, "beacon_gatekeeper": Placed.beacon_gatekeeper,
    "beacon_ritual": Placed.beacon_ritual,
}


def arrow(ctx: Context) -> tuple[float, int] | None:
    """Bearing (degrees, relative to the camera) and distance from the hero to the active step's marker."""
    active = ctx.story.quests("active")
    if not active:
        return None
    steps = ctx.story.quest(active[0]).active_steps
    marker = MARKERS.get(active[0].data.steps[steps[0]].marker or "") if steps else None
    if marker is None:
        return None
    here = ctx.world.query(tagged=Hero).single().transform.position
    offset = (ctx.world.placement(marker).position - here).flat()
    ahead, right = ctx.camera.main.relative(vec2(0, 1)), ctx.camera.main.relative(vec2(1, 0))
    return math.degrees(math.atan2(offset.dot(right), offset.dot(ahead))), round(offset.length())


def boss(ctx: Context) -> dict[str, object]:
    """The boss the hero is fighting, if any."""
    row = (
        ctx.world.query(Health, Threat, Nameplate, tagged=[Hostile, Boss])
        .where(lambda e, health, threat, plate: threat.engaged)
        .first()
    )
    if row is None:
        return {"on": False}
    _, health, _, plate = row
    # The template's encounter AI marks a boss ENRAGED under half health, and the HUD's subtitle follows.
    enraged = health.current < health.max * 0.5
    return {"on": True, "name": plate.text, "width": percent(health.current, health.max),
            "sub": ctx.text(Text.hud_boss_enraged if enraged else Text.hud_boss_hint)}


def rift(ctx: Context) -> dict[str, object]:
    if not rift_running(ctx):
        return {"on": False, "storm": "0"}
    clock = ctx.get(Doom).clock
    left = math.ceil(clock.remaining)
    return {
        "on": True, "remaining": left, "crit": left < 60, "crit10": left < 10,
        "width": percent(clock.remaining, clock.duration),
        "storm": f"{0.15 + clock.progress * 0.5:.2f}",
    }


def prompt(ctx: Context) -> dict[str, object]:
    npc = ctx.get(Focus).npc
    if npc is None or ctx.story.in_dialogue:
        return {"on": False}
    verb = Text.trade_with if npc.has(Merchant) else Text.talk_to
    return {"on": True, "verb": ctx.text(verb), "name": npc.get(Nameplate).text}


def news(ctx: Context) -> dict[str, object]:
    """The toasts still on screen, the level banner and the combat hint, from game/feed.py."""
    feed, now = ctx.get(Feed), ctx.time.now
    recent = [line for line in feed.lines if now - line.at < TOAST_FOR and line.kind is not Kind.LEVEL]
    toasts = [
        {
            "quest": line.kind is Kind.QUEST, "bought": line.kind is Kind.BOUGHT, "note": line.kind is Kind.NOTE,
            "small": line.kind is not Kind.QUEST, "fading": now - line.at > TOAST_FADES_AT,
            "text": line.text, "detail": line.detail,
        }
        for line in recent[-TOASTS_SHOWN:]
    ]
    levels = [line for line in feed.lines if line.kind is Kind.LEVEL]
    level = levels[-1] if levels else None
    return {
        "toasts": toasts,
        "level": {"on": level is not None and now - level.at < LEVEL_FOR,
                  "text": level.text if level else "", "detail": level.detail if level else ""},
        "hint": {"on": now - feed.hint_at < HINT_FOR, "text": feed.hint},
    }


def dock(ctx: Context, hero: Entity) -> dict[str, dict[str, object]]:
    """Strike, Dodge, both ability slots and the potion, each ready / cooling / locked / off."""
    book, mana = hero.get(Spellbook), hero.get(Mana)
    dodge = hero.get(Dodge).ready
    potions = potion_count(ctx)
    return {
        "strike": slot("MOUSE 1 / J", ctx.text(Text.strike), "ready", ctx.text(Text.slot_strike)),
        "dodge": slot("MOUSE 2 / C", ctx.text(Text.dodge), "ready", ctx.text(Text.slot_dodge)) if dodge.done else
        cooling("MOUSE 2 / C", ctx.text(Text.dodge), f"{dodge.duration:.1f} s", f"{dodge.remaining:.1f}",
                100 * dodge.remaining / max(dodge.duration, 0.01)),
        "rune": spell_slot(ctx, book, mana, 1, "Q"),
        "mend": spell_slot(ctx, book, mana, 2, "R"),
        "potion": slot("F", ctx.text(Text.potion), "ready" if potions else "off",
                       ctx.text(Text.slot_potions, count=potions) if potions else ctx.text(Text.slot_empty)),
    }


def spell_slot(ctx: Context, book: Spellbook, mana: Mana, number: int, key: str) -> dict[str, object]:
    spec = ctx.content(AbilityDef).first(lambda a: a.slot == number)
    name = ctx.text(spec.data.name)
    if spec not in book.known:
        return slot(key, name, "locked", ctx.text(Text.slot_locked))
    left = book.cooldowns.get(spec, 0)
    if left > 0:
        return cooling(key, name, f"{spec.data.cooldown:g} s", str(math.ceil(left)), 100 * left / spec.data.cooldown)
    effect = (ctx.text(Text.effect_interrupts) if spec.data.form == "wave"
              else ctx.text(Text.effect_heals, amount=round(spec.data.heal)))
    state = "ready" if mana.current >= spec.data.mana_cost else "off"
    return slot(key, name, state, ctx.text(Text.slot_spell, mana=round(spec.data.mana_cost), effect=effect))


def slot(key: str, name: str, state: str, sub: str) -> dict[str, object]:
    return {"key": key, "name": name, "sub": sub, "off": state != "ready", "cool": False, "lock": state == "locked",
            "count": "", "sweep": ""}


def cooling(key: str, name: str, sub: str, count: str, sweep: float) -> dict[str, object]:
    return {"key": key, "name": name, "sub": sub, "off": True, "cool": True, "lock": False, "count": count,
            "sweep": f"conic-gradient(rgba(4,8,9,.8) 0 {sweep:.1f}%, rgba(4,8,9,0) 0)"}
