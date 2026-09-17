"""HTTP boundary between the desktop application and the Business Assistant API."""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet

from business_assistant_desktop.session import Session


@dataclass(frozen=True, slots=True)
class Organization:
    """An organization available to the authenticated user."""

    id: UUID
    name: str
    slug: str
    role: str


@dataclass(frozen=True, slots=True)
class SignUpResult:
    """Whether signup produced a session or awaits email confirmation."""

    session: Session | None
    email_confirmation_required: bool


@dataclass(frozen=True, slots=True)
class Customer:
    id: UUID
    name: str
    email: str | None
    phone: str | None
    notes: str


@dataclass(frozen=True, slots=True)
class Task:
    id: UUID
    organization_id: UUID
    created_by: UUID
    title: str
    description: str
    due_at: str | None
    status: str
    priority: str


@dataclass(frozen=True, slots=True)
class DocumentTemplate:
    id: UUID
    organization_id: UUID
    created_by: UUID
    name: str
    description: str
    content: str
    is_archived: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class Document:
    id: UUID
    organization_id: UUID
    template_id: UUID | None
    created_by: UUID
    title: str
    content: str
    status: str
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class Transaction:
    id: UUID
    organization_id: UUID
    created_by: UUID
    transaction_type: str
    amount: Decimal
    transaction_date: date
    category: str
    counterparty: str
    memo: str
    is_archived: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class FinanceSummary:
    from_date: date | None
    to_date: date | None
    income_total: Decimal
    expense_total: Decimal
    net_total: Decimal
    transaction_count: int


@dataclass(frozen=True, slots=True)
class FileAsset:
    id: UUID
    organization_id: UUID
    uploaded_by: UUID
    original_name: str
    content_type: str
    size_bytes: int
    is_archived: bool
    created_at: str
    updated_at: str


class ApiClient:
    """Request authenticated data from the server without direct database access."""

    def __init__(self, base_url: str, client: httpx.Client) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client

    def login(self, email: str, password: str) -> Session:
        """Authenticate with the API and keep the returned tokens in the caller's session."""
        response = self._client.post(
            f"{self._base_url}/api/v1/auth/login",
            json={"email": email, "password": password},
        )
        response.raise_for_status()
        return _session_from_payload(_response_object(response))

    def sign_up(self, email: str, password: str, display_name: str) -> SignUpResult:
        """Create an account and report if email confirmation is required."""
        response = self._client.post(
            f"{self._base_url}/api/v1/auth/signup",
            json={"email": email, "password": password, "display_name": display_name},
        )
        response.raise_for_status()
        payload = _response_object(response)
        if payload.get("email_confirmation_required") is True:
            return SignUpResult(session=None, email_confirmation_required=True)
        return SignUpResult(
            session=_session_from_payload(payload),
            email_confirmation_required=False,
        )

    def list_organizations(self, session: Session) -> list[Organization]:
        """Return the organizations available to an authenticated user."""
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload: object = response.json()
        if not isinstance(payload, list):
            raise ValueError("Organization response must be a list")
        return [_organization_from_payload(_object(item)) for item in payload]

    def create_organization(self, name: str, slug: str, session: Session) -> Organization:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations",
            json={"name": name, "slug": slug},
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        return _organization_from_payload(_response_object(response))

    def list_customers(self, organization_id: UUID, session: Session) -> list[Customer]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return [_customer_from_payload(_object(item)) for item in response.json()]

    def create_customer(
        self,
        organization_id: UUID,
        session: Session,
        name: str,
        email: str | None,
        phone: str | None,
        notes: str,
    ) -> Customer:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers",
            headers=_auth_header(session),
            json={"name": name, "email": email, "phone": phone, "notes": notes},
        )
        response.raise_for_status()
        return _customer_from_payload(_response_object(response))

    def update_customer(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        values: dict[str, str | None],
    ) -> Customer:
        response = self._client.patch(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _customer_from_payload(_response_object(response))

    def delete_customer(self, organization_id: UUID, session: Session, customer_id: UUID) -> bool:
        response = self._client.delete(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return True

    def list_tasks(
        self, organization_id: UUID, session: Session, status: str | None = None
    ) -> list[Task]:
        params = {"status": status} if status is not None else None
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/tasks",
            headers=_auth_header(session),
            params=params,
        )
        response.raise_for_status()
        return [_task_from_payload(_object(item)) for item in response.json()]

    def create_task(
        self,
        organization_id: UUID,
        session: Session,
        title: str,
        description: str = "",
        due_at: str | None = None,
        status: str = "open",
        priority: str = "normal",
    ) -> Task:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/tasks",
            headers=_auth_header(session),
            json={
                "title": title,
                "description": description,
                "due_at": due_at,
                "status": status,
                "priority": priority,
            },
        )
        response.raise_for_status()
        return _task_from_payload(_response_object(response))

    def update_task(
        self, organization_id: UUID, session: Session, task_id: UUID, values: dict[str, object]
    ) -> Task:
        response = self._client.patch(
            f"{self._base_url}/api/v1/organizations/{organization_id}/tasks/{task_id}",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _task_from_payload(_response_object(response))

    def delete_task(self, organization_id: UUID, session: Session, task_id: UUID) -> bool:
        response = self._client.delete(
            f"{self._base_url}/api/v1/organizations/{organization_id}/tasks/{task_id}",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return True

    def list_document_templates(
        self, organization_id: UUID, session: Session
    ) -> list[DocumentTemplate]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/document-templates",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return [_document_template_from_payload(_object(item)) for item in response.json()]

    def list_documents(self, organization_id: UUID, session: Session) -> list[Document]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/documents",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return [_document_from_payload(_object(item)) for item in response.json()]

    def create_document(
        self,
        organization_id: UUID,
        session: Session,
        title: str,
        content: str = "",
        template_id: UUID | None = None,
    ) -> Document:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/documents",
            headers=_auth_header(session),
            json={
                "title": title,
                "content": content,
                "template_id": str(template_id) if template_id else None,
            },
        )
        response.raise_for_status()
        return _document_from_payload(_response_object(response))

    def list_transactions(
        self,
        organization_id: UUID,
        session: Session,
        transaction_type: str | None = None,
        from_date: date | None = None,
        to_date: date | None = None,
    ) -> list[Transaction]:
        params: dict[str, str] = {}
        if transaction_type is not None:
            params["transaction_type"] = transaction_type
        if from_date is not None:
            params["from_date"] = from_date.isoformat()
        if to_date is not None:
            params["to_date"] = to_date.isoformat()
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/finance-transactions",
            headers=_auth_header(session),
            params=params,
        )
        response.raise_for_status()
        return [_transaction_from_payload(_object(item)) for item in response.json()]

    def get_finance_summary(
        self,
        organization_id: UUID,
        session: Session,
        from_date: date | None = None,
        to_date: date | None = None,
    ) -> FinanceSummary:
        params = {
            key: value.isoformat()
            for key, value in (("from_date", from_date), ("to_date", to_date))
            if value is not None
        }
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/finance-summary",
            headers=_auth_header(session),
            params=params,
        )
        response.raise_for_status()
        return _finance_summary_from_payload(_response_object(response))

    def list_files(self, organization_id: UUID, session: Session) -> list[FileAsset]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/files",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return [_file_from_payload(_object(item)) for item in response.json()]

    def upload_file(self, organization_id: UUID, session: Session, path: Path) -> FileAsset:
        content = path.read_bytes()
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/files/upload-url",
            headers=_auth_header(session),
            json={
                "original_name": path.name,
                "content_type": "application/octet-stream",
                "size_bytes": len(content),
            },
        )
        response.raise_for_status()
        payload = _response_object(response)
        signed_url = _required_string(payload, "signed_url")
        upload = self._client.put(
            signed_url, content=content, headers={"Content-Type": "application/octet-stream"}
        )
        upload.raise_for_status()
        return _file_from_payload(_object(payload.get("file")))

    def get_download_url(self, organization_id: UUID, session: Session, file_id: UUID) -> str:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/files/{file_id}/download-url",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return _required_string(_response_object(response), "signed_url")

    def archive_file(self, organization_id: UUID, session: Session, file_id: UUID) -> FileAsset:
        response = self._client.delete(
            f"{self._base_url}/api/v1/organizations/{organization_id}/files/{file_id}",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return _file_from_payload(_response_object(response))

    def get_entitlements(self, organization_id: UUID, session: Session) -> EntitlementSet:
        """Return the server-calculated features for an organization."""
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/entitlements",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload = _response_object(response)
        features = payload.get("features")
        if not isinstance(features, list) or not all(
            isinstance(feature, str) for feature in features
        ):
            raise ValueError("Entitlement response must contain string features")
        return EntitlementSet(frozenset(features))


def _response_object(response: httpx.Response) -> dict[str, object]:
    return _object(response.json())


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("API response must be an object")
    return cast(dict[str, object], value)


def _required_string(payload: dict[str, object], field_name: str) -> str:
    value = payload.get(field_name)
    if not isinstance(value, str):
        raise ValueError(f"API response field {field_name} must be a string")
    return value


def _session_from_payload(payload: dict[str, object]) -> Session:
    refresh_token = payload.get("refresh_token")
    if refresh_token is not None and not isinstance(refresh_token, str):
        raise ValueError("API response field refresh_token must be a string or null")
    user = _object(payload.get("user"))
    return Session(
        access_token=_required_string(payload, "access_token"),
        refresh_token=refresh_token,
        user_id=UUID(_required_string(user, "user_id")),
    )


def _organization_from_payload(payload: dict[str, object]) -> Organization:
    return Organization(
        id=UUID(_required_string(payload, "id")),
        name=_required_string(payload, "name"),
        slug=_required_string(payload, "slug"),
        role=_required_string(payload, "role"),
    )


def _auth_header(session: Session) -> dict[str, str]:
    return {"Authorization": f"Bearer {session.access_token}"}


def _customer_from_payload(payload: dict[str, object]) -> Customer:
    return Customer(
        UUID(_required_string(payload, "id")),
        _required_string(payload, "name"),
        _optional_string(payload, "email"),
        _optional_string(payload, "phone"),
        _required_string(payload, "notes"),
    )


def _optional_string(payload: dict[str, object], field_name: str) -> str | None:
    value = payload.get(field_name)
    if value is not None and not isinstance(value, str):
        raise ValueError(f"API response field {field_name} must be a string or null")
    return value


def _task_from_payload(payload: dict[str, object]) -> Task:
    return Task(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "organization_id")),
        UUID(_required_string(payload, "created_by")),
        _required_string(payload, "title"),
        _required_string(payload, "description"),
        _optional_string(payload, "due_at"),
        _required_string(payload, "status"),
        _required_string(payload, "priority"),
    )


def _document_template_from_payload(payload: dict[str, object]) -> DocumentTemplate:
    return DocumentTemplate(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "organization_id")),
        UUID(_required_string(payload, "created_by")),
        _required_string(payload, "name"),
        _required_string(payload, "description"),
        _required_string(payload, "content"),
        _required_bool(payload, "is_archived"),
        _required_string(payload, "created_at"),
        _required_string(payload, "updated_at"),
    )


def _document_from_payload(payload: dict[str, object]) -> Document:
    template_id = payload.get("template_id")
    return Document(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "organization_id")),
        UUID(template_id) if isinstance(template_id, str) else None,
        UUID(_required_string(payload, "created_by")),
        _required_string(payload, "title"),
        _required_string(payload, "content"),
        _required_string(payload, "status"),
        _required_string(payload, "created_at"),
        _required_string(payload, "updated_at"),
    )


def _transaction_from_payload(payload: dict[str, object]) -> Transaction:
    amount = payload.get("amount")
    if not isinstance(amount, (str, int, float)) or isinstance(amount, bool):
        raise ValueError("API response field amount must be numeric")
    return Transaction(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "organization_id")),
        UUID(_required_string(payload, "created_by")),
        _required_string(payload, "transaction_type"),
        Decimal(str(amount)),
        date.fromisoformat(_required_string(payload, "transaction_date")),
        _required_string(payload, "category"),
        _required_string(payload, "counterparty"),
        _required_string(payload, "memo"),
        _required_bool(payload, "is_archived"),
        _required_string(payload, "created_at"),
        _required_string(payload, "updated_at"),
    )


def _finance_summary_from_payload(payload: dict[str, object]) -> FinanceSummary:
    def decimal(name: str) -> Decimal:
        value = payload.get(name)
        if not isinstance(value, (str, int, float)) or isinstance(value, bool):
            raise ValueError(f"API response field {name} must be numeric")
        return Decimal(str(value))

    def optional_date(name: str) -> date | None:
        value = payload.get(name)
        return date.fromisoformat(value) if isinstance(value, str) else None

    count = payload.get("transaction_count")
    if not isinstance(count, int) or isinstance(count, bool):
        raise ValueError("API response field transaction_count must be an integer")
    return FinanceSummary(
        optional_date("from_date"),
        optional_date("to_date"),
        decimal("income_total"),
        decimal("expense_total"),
        decimal("net_total"),
        count,
    )


def _file_from_payload(payload: dict[str, object]) -> FileAsset:
    size = payload.get("size_bytes")
    if not isinstance(size, int) or isinstance(size, bool):
        raise ValueError("API response field size_bytes must be an integer")
    return FileAsset(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "organization_id")),
        UUID(_required_string(payload, "uploaded_by")),
        _required_string(payload, "original_name"),
        _required_string(payload, "content_type"),
        size,
        _required_bool(payload, "is_archived"),
        _required_string(payload, "created_at"),
        _required_string(payload, "updated_at"),
    )


def _required_bool(payload: dict[str, object], field_name: str) -> bool:
    value = payload.get(field_name)
    if not isinstance(value, bool):
        raise ValueError(f"API response field {field_name} must be a boolean")
    return value
