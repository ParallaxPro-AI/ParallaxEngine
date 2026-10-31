"""Plain tests: no harness."""


def helper_not_collected():
    raise AssertionError("never called")


def test_arithmetic():
    assert 7 // 2 == 3


async def test_async_plain():
    assert [1, 2] + [3] == [1, 2, 3]
