"""HTTP boundary between the desktop application and the Business Assistant API."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast
from uuid import UUID

import httpx
from business_assistant_common.entitlements import EntitlementSet

from business_assistant_desktop.session import Session
from business_assistant_desktop.upload_transfer import UploadCancelled, upload_chunks


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
    email: str | None = None
    phone: str | None = None
    notes: str = ""
    tags: tuple[str, ...] = ()
    status: str = "active"
    birth_date: str | None = None
    skin_type: str | None = None
    concerns: tuple[str, ...] = ()
    allergies: str = ""
    last_visit_date: str | None = None
    next_visit_date: str | None = None


@dataclass(frozen=True, slots=True)
class CustomerActivity:
    id: UUID
    customer_id: UUID
    activity_type: str
    title: str
    description: str
    occurred_at: str


@dataclass(frozen=True, slots=True)
class CustomerPhoto:
    id: UUID
    customer_id: UUID
    storage_path: str
    content_type: str
    size_bytes: int
    caption: str
    created_at: str


@dataclass(frozen=True, slots=True)
class Treatment:
    id: UUID
    customer_id: UUID
    treatment_date: str
    treatment_name: str
    category: str
    practitioner: str
    notes: str
    amount: Decimal | None
    next_visit_date: str | None
    status: str = "legacy"
    version: int = 1
    started_at: str | None = None
    ended_at: str | None = None
    consultation_goal: str = ""
    consultation_plan: str = ""
    cautions_snapshot: dict[str, object] = field(default_factory=dict)
    cautions_acknowledged_by: UUID | None = None
    cautions_acknowledged_at: str | None = None


@dataclass(frozen=True, slots=True)
class TreatmentPhoto:
    id: UUID
    customer_id: UUID
    treatment_id: UUID
    storage_path: str
    thumbnail_path: str | None
    content_type: str
    caption: str
    sort_order: int
    taken_at: str | None


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
    status: str = "draft"
    version: int = 1
    revision: int = 1


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

    @property
    def recovery_origin(self) -> str:
        return self._base_url

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

    def create_customer_record(
        self, organization_id: UUID, session: Session, values: dict[str, object]
    ) -> Customer:
        """Create a complete customer profile in one request."""
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _customer_from_payload(_response_object(response))

    def update_customer(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        values: dict[str, object],
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

    def list_customer_activities(
        self, organization_id: UUID, session: Session, customer_id: UUID
    ) -> list[CustomerActivity]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}"
            f"/customers/{customer_id}/activities",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        payload: object = response.json()
        if not isinstance(payload, list):
            raise ValueError("Customer activity response must be a list")
        return [_customer_activity_from_payload(_object(item)) for item in payload]

    def create_customer_activity(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        values: dict[str, object],
    ) -> CustomerActivity:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}"
            f"/customers/{customer_id}/activities",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _customer_activity_from_payload(_response_object(response))

    def list_customer_photos(
        self, organization_id: UUID, session: Session, customer_id: UUID
    ) -> list[CustomerPhoto]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/photos",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Customer photo response must be a list")
        return [_customer_photo_from_payload(_object(item)) for item in payload]

    def upload_customer_photo(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        original_name: str,
        content: bytes,
        content_type: str,
        caption: str = "",
        *,
        on_progress: Callable[[int, int], None] | None = None,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> CustomerPhoto:
        if is_cancelled and is_cancelled():
            raise UploadCancelled()
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/photos/upload-url",
            headers=_auth_header(session),
            json={
                "original_name": original_name,
                "content_type": content_type,
                "size_bytes": len(content),
                "caption": caption,
            },
        )
        response.raise_for_status()
        payload = _response_object(response)
        signed_url = _required_string(payload, "signed_url")
        photo = _customer_photo_from_payload(_object(payload.get("photo")))
        try:
            upload = self._client.put(
                signed_url,
                content=upload_chunks(content, on_progress, is_cancelled),
                headers={"Content-Type": content_type, "Content-Length": str(len(content))},
            )
            upload.raise_for_status()
        except Exception as exc:
            try:
                cleanup = self._client.delete(
                    f"{self._base_url}/api/v1/organizations/{organization_id}"
                    f"/customers/{customer_id}/photos/{photo.id}",
                    headers=_auth_header(session),
                )
                cleanup.raise_for_status()
            except Exception:
                raise RuntimeError(
                    "전송 결과를 확인하지 못했고 사진 기록 정리도 실패했습니다. "
                    "사진 목록을 새로고침해 확인해 주세요."
                ) from exc
            raise
        return photo

    def download_customer_photo(
        self, organization_id: UUID, session: Session, customer_id: UUID, photo_id: UUID
    ) -> bytes:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/photos/{photo_id}/download-url",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        signed_url = _required_string(_response_object(response), "signed_url")
        image = self._client.get(signed_url)
        image.raise_for_status()
        return image.content

    def list_treatments(
        self, organization_id: UUID, session: Session, customer_id: UUID
    ) -> list[Treatment]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/treatments",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Treatment response must be a list")
        return [_treatment_from_payload(_object(row)) for row in payload]

    def create_treatment(
        self, organization_id: UUID, session: Session, customer_id: UUID, values: dict[str, object]
    ) -> Treatment:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/treatments",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _treatment_from_payload(_response_object(response))

    def update_treatment(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> Treatment:
        response = self._client.patch(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}",
            headers=_auth_header(session),
            json=values,
        )
        response.raise_for_status()
        return _treatment_from_payload(_response_object(response))

    def mutate_treatment(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> Treatment:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/mutations",
            headers={"Authorization": f"Bearer {session.access_token}"},
            json=values,
        )
        response.raise_for_status()
        return _treatment_from_payload(_object(response.json()))

    def list_treatment_events(
        self, organization_id: UUID, session: Session, customer_id: UUID, treatment_id: UUID
    ) -> list[dict[str, object]]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/events",
            headers={"Authorization": f"Bearer {session.access_token}"},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected treatment event list")
        return [_object(row) for row in payload]

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

    def list_document_consent_events(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
    ) -> list[dict[str, object]]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}"
            f"/documents/{document_id}/events"
        )
        response = self._client.get(
            f"{self._base_url}/api/v1/{path}", headers=_auth_header(session)
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected consent event list")
        return [_object(row) for row in payload]

    def record_document_consent_event(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        document_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}"
            f"/documents/{document_id}/events"
        )
        response = self._client.post(
            f"{self._base_url}/api/v1/{path}", headers=_auth_header(session), json=payload
        )
        response.raise_for_status()
        return _response_object(response)

    def preview_treatment_document(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        template_id: UUID,
    ) -> dict[str, object]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}/documents"
        )
        response = self._client.post(
            f"{self._base_url}/api/v1/{path}/preview",
            headers=_auth_header(session),
            json={"template_id": str(template_id)},
        )
        response.raise_for_status()
        return _response_object(response)

    def issue_treatment_document(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}/documents"
        )
        response = self._client.post(
            f"{self._base_url}/api/v1/{path}",
            headers=_auth_header(session),
            json=payload,
        )
        response.raise_for_status()
        return _response_object(response)

    def list_issued_treatment_documents(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
    ) -> list[dict[str, object]]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}/documents"
        )
        response = self._client.get(
            f"{self._base_url}/api/v1/{path}",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected issued document list")
        return [_object(item) for item in payload]

    def preview_treatment_sale_draft(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        values: dict[str, object],
    ) -> dict[str, object]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}/sale-draft/preview"
        )
        response = self._client.post(
            f"{self._base_url}/api/v1/{path}",
            headers=_auth_header(session),
            json={"values": values},
        )
        response.raise_for_status()
        return _response_object(response)

    def create_treatment_sale_draft(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        treatment_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]:
        path = (
            f"organizations/{organization_id}/customers/{customer_id}"
            f"/treatments/{treatment_id}/sale-draft"
        )
        response = self._client.post(
            f"{self._base_url}/api/v1/{path}",
            headers=_auth_header(session),
            json=payload,
        )
        response.raise_for_status()
        return _response_object(response)

    def list_treatment_sale_drafts(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID | None = None,
        treatment_id: UUID | None = None,
    ) -> list[dict[str, object]]:
        if (customer_id is None) != (treatment_id is None):
            raise ValueError("Customer and treatment must be provided together")
        path = f"organizations/{organization_id}/treatment-sale-drafts"
        if customer_id is not None:
            path = (
                f"organizations/{organization_id}/customers/{customer_id}"
                f"/treatments/{treatment_id}/sale-draft"
            )
        response = self._client.get(
            f"{self._base_url}/api/v1/{path}", headers=_auth_header(session)
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected sale draft list")
        return [_object(item) for item in payload]

    def list_customer_visits(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID | None = None,
        status: str | None = None,
    ) -> list[dict[str, object]]:
        params = {}
        if customer_id is not None:
            params["customer_id"] = str(customer_id)
        if status is not None:
            params["status"] = status
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/visits",
            headers=_auth_header(session),
            params=params,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected visit list")
        return [_object(item) for item in payload]

    def list_sale_cart_drafts(
        self,
        organization_id: UUID,
        session: Session,
    ) -> list[dict[str, object]]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/sale-cart-drafts",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise ValueError("Expected sale cart draft list")
        return [_object(item) for item in payload]

    def create_customer_visit(
        self,
        organization_id: UUID,
        session: Session,
        customer_id: UUID,
        operation_id: UUID,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"customers/{customer_id}/visits",
            {"operation_id": str(operation_id)},
        )

    def get_sale_cart(
        self, organization_id: UUID, session: Session, visit_id: UUID
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "GET", organization_id, session, f"visits/{visit_id}/sale-cart"
        )

    def add_treatment_draft_to_cart(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        draft_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"visits/{visit_id}/sale-cart/lines/treatment-draft",
            {
                "draft_id": str(draft_id),
                "expected_version": expected_version,
                "operation_id": str(operation_id),
            },
        )

    def update_sale_cart_line(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        line_id: UUID,
        expected_version: int,
        operation_id: UUID,
        values: dict[str, object],
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "PATCH",
            organization_id,
            session,
            f"visits/{visit_id}/sale-cart/lines/{line_id}",
            {
                **values,
                "expected_version": expected_version,
                "operation_id": str(operation_id),
            },
        )

    def remove_sale_cart_line(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        line_id: UUID,
        expected_version: int,
        operation_id: UUID,
        reason: str,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"visits/{visit_id}/sale-cart/lines/{line_id}/remove",
            {
                "reason": reason,
                "expected_version": expected_version,
                "operation_id": str(operation_id),
            },
        )

    def restore_sale_cart_line(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        line_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"visits/{visit_id}/sale-cart/lines/{line_id}/restore",
            {"expected_version": expected_version, "operation_id": str(operation_id)},
        )

    def review_sale_cart(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
        ready: bool,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"visits/{visit_id}/sale-cart/review",
            {
                "ready": ready,
                "expected_version": expected_version,
                "operation_id": str(operation_id),
            },
        )

    def cancel_customer_visit(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        expected_version: int,
        operation_id: UUID,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST",
            organization_id,
            session,
            f"visits/{visit_id}/cancel",
            {"expected_version": expected_version, "operation_id": str(operation_id)},
        )

    def _sale_cart_request(
        self,
        method: str,
        organization_id: UUID,
        session: Session,
        path: str,
        payload: dict[str, object] | None = None,
    ) -> dict[str, object]:
        response = self._client.request(
            method,
            f"{self._base_url}/api/v1/organizations/{organization_id}/{path}",
            headers=_auth_header(session),
            json=payload,
        )
        response.raise_for_status()
        return _response_object(response)

    def get_visit_payments(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "GET", organization_id, session, f"visits/{visit_id}/payments"
        )

    def record_visit_payment(
        self,
        organization_id: UUID,
        session: Session,
        visit_id: UUID,
        payload: dict[str, object],
    ) -> dict[str, object]:
        return self._sale_cart_request(
            "POST", organization_id, session, f"visits/{visit_id}/payments", payload
        )

    def mutate_document_template(
        self,
        organization_id: UUID,
        session: Session,
        template_id: UUID,
        payload: dict[str, object],
    ) -> DocumentTemplate:
        response = self._client.post(
            f"{self._base_url}/api/v1/organizations/{organization_id}/document-templates/{template_id}/mutations",
            headers=_auth_header(session),
            json=payload,
        )
        response.raise_for_status()
        return _document_template_from_payload(_response_object(response))

    def list_document_template_versions(
        self,
        organization_id: UUID,
        session: Session,
        template_id: UUID,
    ) -> list[dict[str, object]]:
        response = self._client.get(
            f"{self._base_url}/api/v1/organizations/{organization_id}/document-templates/{template_id}/versions",
            headers=_auth_header(session),
        )
        response.raise_for_status()
        return [_object(item) for item in response.json()]

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
    raw_tags = payload.get("tags", [])
    tags = (
        tuple(item for item in raw_tags if isinstance(item, str))
        if isinstance(raw_tags, list)
        else ()
    )
    raw_concerns = payload.get("concerns", [])
    concerns = (
        tuple(item for item in raw_concerns if isinstance(item, str))
        if isinstance(raw_concerns, list)
        else ()
    )
    return Customer(
        UUID(_required_string(payload, "id")),
        _required_string(payload, "name"),
        _optional_string(payload, "email"),
        _optional_string(payload, "phone"),
        _required_string(payload, "notes"),
        tags,
        _optional_string(payload, "status") or "active",
        _optional_string(payload, "birth_date"),
        _optional_string(payload, "skin_type"),
        concerns,
        _optional_string(payload, "allergies") or "",
        _optional_string(payload, "last_visit_date"),
        _optional_string(payload, "next_visit_date"),
    )


def _customer_activity_from_payload(payload: dict[str, object]) -> CustomerActivity:
    return CustomerActivity(
        id=UUID(_required_string(payload, "id")),
        customer_id=UUID(_required_string(payload, "customer_id")),
        activity_type=_required_string(payload, "activity_type"),
        title=_required_string(payload, "title"),
        description=_required_string(payload, "description"),
        occurred_at=_required_string(payload, "occurred_at"),
    )


def _customer_photo_from_payload(payload: dict[str, object]) -> CustomerPhoto:
    raw_size = payload.get("size_bytes")
    if not isinstance(raw_size, int) or isinstance(raw_size, bool):
        raise ValueError("API response field size_bytes must be an integer")
    return CustomerPhoto(
        id=UUID(_required_string(payload, "id")),
        customer_id=UUID(_required_string(payload, "customer_id")),
        storage_path=_required_string(payload, "storage_path"),
        content_type=_required_string(payload, "content_type"),
        size_bytes=raw_size,
        caption=_required_string(payload, "caption"),
        created_at=_required_string(payload, "created_at"),
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
        _required_string(payload, "status") if "status" in payload else "draft",
        int(str(payload.get("version", 1))),
        int(str(payload.get("revision", 1))),
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


def _treatment_from_payload(payload: dict[str, object]) -> Treatment:
    status = payload.get("status", "legacy")
    version = payload.get("version", 1)
    if status not in ("legacy", "draft", "in_progress", "completed", "cancelled"):
        raise ValueError("Invalid treatment status")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("Invalid treatment version")
    raw = payload.get("amount")
    try:
        amount = Decimal(str(raw)) if raw is not None else None
        if amount is not None and (not amount.is_finite() or amount < 0):
            raise ValueError("Invalid treatment amount")
    except InvalidOperation as exc:
        raise ValueError("Invalid treatment amount") from exc
    return Treatment(
        UUID(_required_string(payload, "id")),
        UUID(_required_string(payload, "customer_id")),
        _required_string(payload, "treatment_date"),
        _required_string(payload, "treatment_name"),
        _required_string(payload, "category"),
        _required_string(payload, "practitioner"),
        _required_string(payload, "notes"),
        amount,
        _optional_string(payload, "next_visit_date"),
        str(status),
        version,
        _optional_string(payload, "started_at"),
        _optional_string(payload, "ended_at"),
        _required_string(payload, "consultation_goal") if "consultation_goal" in payload else "",
        _required_string(payload, "consultation_plan") if "consultation_plan" in payload else "",
        _object(payload.get("cautions_snapshot", {})),
        UUID(str(payload["cautions_acknowledged_by"]))
        if payload.get("cautions_acknowledged_by") is not None
        else None,
        _optional_string(payload, "cautions_acknowledged_at"),
    )
