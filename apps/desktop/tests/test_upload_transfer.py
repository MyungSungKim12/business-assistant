from threading import Event

import pytest
from business_assistant_desktop.upload_transfer import UploadCancelled, upload_chunks


def test_stream_preserves_bytes_and_reports_consumed_chunks():
    data = b"a" * 150_000
    reports = []
    chunks = upload_chunks(data, lambda sent, total: reports.append((sent, total)))
    assert b"".join(chunks) == data
    assert reports == [(0, 150_000), (65536, 150_000), (131072, 150_000), (150000, 150_000)]


def test_cancel_between_chunks_stops_next_bytes():
    cancel = Event()
    chunks = upload_chunks(b"x" * 150_000, cancelled=cancel.is_set)
    assert len(next(chunks)) == 65536
    cancel.set()
    with pytest.raises(UploadCancelled):
        next(chunks)
