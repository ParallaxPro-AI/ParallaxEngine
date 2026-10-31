"""Inventory arithmetic on immutable stacks.

Every change is planned on a copy and returned whole, or refused with None, so a
craft that runs out of room never eats its ingredients and a full backpack never
half-accepts a pickup.
"""

from collections.abc import Sequence

from parallax import ContentRef

from game.content import ItemDef, Stack


def count_of(slots: Sequence[Stack], item: ContentRef[ItemDef]) -> int:
    return sum(s.count for s in slots if s.item == item)


def is_empty(slots: Sequence[Stack]) -> bool:
    return all(s.count == 0 for s in slots)


def transact(slots: Sequence[Stack], take: Sequence[Stack] = (), give: Sequence[Stack] = ()) -> list[Stack] | None:
    """Remove `take` and add `give`, or None if either doesn't fit."""
    result = list(slots)
    for want in take:
        if count_of(result, want.item) < want.count:
            return None
        result = _remove(result, want)
    for extra in give:
        result = _add(result, extra)
        if result is None:
            return None
    return result


def _remove(slots: list[Stack], want: Stack) -> list[Stack]:
    left = want.count
    result = []
    for slot in slots:
        taken = min(left, slot.count) if slot.item == want.item else 0
        left -= taken
        result.append(_with_count(slot, slot.count - taken))
    return result


def _add(slots: list[Stack], extra: Stack) -> list[Stack] | None:
    cap = extra.item.data.stack_max
    left = extra.count
    result = list(slots)
    # Top up matching stacks first, then fill empty slots.
    for matching in (True, False):
        for i, slot in enumerate(result):
            fits = slot.item == extra.item if matching else slot.count == 0
            if left == 0 or not fits:
                continue
            moved = min(left, cap - slot.count)
            result[i] = Stack(extra.item, slot.count + moved)
            left -= moved
    return result if left == 0 else None


def _with_count(slot: Stack, count: int) -> Stack:
    return Stack(slot.item, count) if count > 0 else Stack()
