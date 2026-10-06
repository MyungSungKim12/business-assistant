"""Cooperative streaming cancellation without touching GUI objects."""

from collections.abc import Callable, Iterator


class UploadCancelled(Exception):
    """The user requested cancellation before the next upload chunk."""


def upload_chunks(
    content: bytes,
    progress: Callable[[int, int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> Iterator[bytes]:
    total = len(content)
    if progress:
        progress(0, total)
    for offset in range(0, total, 64 * 1024):
        if cancelled and cancelled():
            raise UploadCancelled()
        chunk = content[offset : offset + 64 * 1024]
        yield chunk
        if progress:
            progress(offset + len(chunk), total)
