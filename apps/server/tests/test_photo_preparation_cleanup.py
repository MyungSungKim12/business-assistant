import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from business_assistant_server.api.customer_photos import PhotoUploadRequest, create_upload_url
from business_assistant_server.ports.repositories import RepositoryUnavailableError
from fastapi import HTTPException


@pytest.mark.parametrize("insert_fails", [False, True])
def test_failed_preparation_archives_only_a_created_record(insert_fails):
    org, customer = uuid4(), uuid4()
    repo = SimpleNamespace(create_photo=AsyncMock(), archive_photo=AsyncMock())
    if insert_fails:
        repo.create_photo.side_effect = RepositoryUnavailableError()
    storage = SimpleNamespace(create_upload_url=AsyncMock(side_effect=RepositoryUnavailableError()))
    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_upload_url(
                org,
                customer,
                PhotoUploadRequest(
                    original_name="face.jpg", content_type="image/jpeg", size_bytes=4
                ),
                SimpleNamespace(user_id=uuid4()),
                None,
                None,
                repo,
                storage,
                SimpleNamespace(file_bucket="business-files"),
            )
        )
    assert error.value.status_code == 503
    if insert_fails:
        repo.archive_photo.assert_not_awaited()
        storage.create_upload_url.assert_not_awaited()
    else:
        values = repo.create_photo.call_args.args[3]
        assert str(repo.archive_photo.call_args.args[2]) == values["id"]
        assert repo.archive_photo.call_args.args[:2] == (org, customer)
