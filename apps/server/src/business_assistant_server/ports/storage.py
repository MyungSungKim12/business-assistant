from typing import Protocol, runtime_checkable


@runtime_checkable
class StoragePort(Protocol):
    async def create_upload_url(self, bucket: str, object_path: str) -> str:
        """Return a short-lived URL that uploads one object."""
        ...

    async def create_download_url(self, bucket: str, object_path: str, expires_in: int) -> str:
        """Return a short-lived URL that downloads one object."""
        ...
