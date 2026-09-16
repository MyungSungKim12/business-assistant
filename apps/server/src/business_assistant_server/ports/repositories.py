from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable
from uuid import UUID


class RepositoryUnavailableError(Exception):
    """The organization repository cannot safely complete a request."""

    def __init__(self) -> None:
        super().__init__("Organization service unavailable")


@dataclass(frozen=True, slots=True)
class OrganizationSummary:
    id: UUID
    name: str
    slug: str
    role: str


@dataclass(frozen=True, slots=True)
class MemberSummary:
    user_id: UUID
    role: str


@dataclass(frozen=True, slots=True)
class SubscriptionSummary:
    organization_id: UUID
    plan_code: str
    status: str
    ends_at: datetime | None
    features: list[str]


@dataclass(frozen=True, slots=True)
class CustomerSummary:
    id: UUID
    organization_id: UUID
    name: str
    email: str | None
    phone: str | None
    notes: str


@runtime_checkable
class CustomerRepository(Protocol):
    """Customer data access scoped to an authenticated organization member."""

    async def list_customers(self, organization_id: UUID) -> list[CustomerSummary]: ...

    async def create_customer(
        self,
        organization_id: UUID,
        name: str,
        email: str | None,
        phone: str | None,
        notes: str,
    ) -> CustomerSummary: ...

    async def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, str | None]
    ) -> CustomerSummary | None: ...

    async def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool: ...


@dataclass(frozen=True, slots=True)
class TaskSummary:
    id: UUID
    organization_id: UUID
    created_by: UUID
    title: str
    description: str
    due_at: str | None
    status: str
    priority: str


@runtime_checkable
class TaskRepository(Protocol):
    async def list_tasks(
        self, organization_id: UUID, task_status: str | None
    ) -> list[TaskSummary]: ...

    async def create_task(
        self, organization_id: UUID, created_by: UUID, values: dict[str, str | None]
    ) -> TaskSummary: ...

    async def update_task(
        self, organization_id: UUID, task_id: UUID, user_id: UUID, values: dict[str, str | None]
    ) -> TaskSummary | None: ...
    async def delete_task(self, organization_id: UUID, task_id: UUID, user_id: UUID) -> bool: ...


@dataclass(frozen=True, slots=True)
class DocumentTemplateSummary:
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
class DocumentSummary:
    id: UUID
    organization_id: UUID
    template_id: UUID | None
    created_by: UUID
    title: str
    content: str
    status: str
    created_at: str
    updated_at: str


@runtime_checkable
class DocumentRepository(Protocol):
    async def list_templates(self, organization_id: UUID) -> list[DocumentTemplateSummary]: ...

    async def create_template(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary: ...

    async def update_template(
        self, organization_id: UUID, template_id: UUID, values: dict[str, object]
    ) -> DocumentTemplateSummary | None: ...

    async def list_documents(self, organization_id: UUID) -> list[DocumentSummary]: ...

    async def create_document(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> DocumentSummary: ...

    async def update_document(
        self, organization_id: UUID, document_id: UUID, values: dict[str, object]
    ) -> DocumentSummary | None: ...


@runtime_checkable
class OrganizationRepository(Protocol):
    """Organization data access scoped to the authenticated user."""

    async def create_organization(
        self, user_id: UUID, name: str, slug: str
    ) -> OrganizationSummary: ...

    async def list_organizations_for_user(self, user_id: UUID) -> list[OrganizationSummary]: ...

    async def get_organization(self, organization_id: UUID) -> OrganizationSummary | None: ...

    async def organization_exists(self, organization_id: UUID) -> bool: ...

    async def get_membership(self, user_id: UUID, organization_id: UUID) -> str | None: ...

    async def list_members(self, organization_id: UUID) -> list[MemberSummary]: ...

    async def get_active_subscription(
        self, organization_id: UUID, now: datetime
    ) -> SubscriptionSummary | None: ...
