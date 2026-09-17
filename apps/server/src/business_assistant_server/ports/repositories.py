from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol, runtime_checkable
from uuid import UUID


class RepositoryUnavailableError(Exception):
    """The organization repository cannot safely complete a request."""

    def __init__(self) -> None:
        super().__init__("Organization service unavailable")


class RepositoryValidationError(Exception):
    """The provider rejected a request because its data violated a domain rule."""

    def __init__(self) -> None:
        super().__init__("Repository request is invalid")


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
    birth_date: str | None = None
    skin_type: str | None = None
    concerns: list[str] | None = None
    allergies: str = ""
    last_visit_date: str | None = None
    next_visit_date: str | None = None
    tags: list[str] | None = None
    status: str = "active"


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
        **profile: object,
    ) -> CustomerSummary: ...

    async def update_customer(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> CustomerSummary | None: ...

    async def delete_customer(self, organization_id: UUID, customer_id: UUID) -> bool: ...


@dataclass(frozen=True, slots=True)
class CustomerActivitySummary:
    id: UUID
    organization_id: UUID
    customer_id: UUID
    activity_type: str
    title: str
    description: str
    occurred_at: str


@runtime_checkable
class CustomerActivityRepository(Protocol):
    async def list_activities(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[CustomerActivitySummary]: ...

    async def create_activity(
        self,
        organization_id: UUID,
        customer_id: UUID,
        activity_type: str,
        title: str,
        description: str,
        occurred_at: str | None,
    ) -> CustomerActivitySummary: ...

    async def delete_activity(
        self, organization_id: UUID, customer_id: UUID, activity_id: UUID
    ) -> bool: ...


@dataclass(frozen=True, slots=True)
class TreatmentSummary:
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_date: str
    treatment_name: str
    category: str
    practitioner: str
    notes: str
    amount: Decimal | None
    next_visit_date: str | None


@dataclass(frozen=True, slots=True)
class TreatmentPhotoSummary:
    id: UUID
    organization_id: UUID
    customer_id: UUID
    treatment_id: UUID
    storage_path: str
    thumbnail_path: str | None
    content_type: str
    caption: str
    sort_order: int
    taken_at: str | None


@runtime_checkable
class TreatmentRepository(Protocol):
    async def list_treatments(
        self, organization_id: UUID, customer_id: UUID
    ) -> list[TreatmentSummary]: ...
    async def create_treatment(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> TreatmentSummary: ...
    async def list_photos(
        self, organization_id: UUID, customer_id: UUID, treatment_id: UUID | None = None
    ) -> list[TreatmentPhotoSummary]: ...
    async def create_photo(
        self, organization_id: UUID, customer_id: UUID, values: dict[str, object]
    ) -> TreatmentPhotoSummary: ...
    async def delete_photo(
        self, organization_id: UUID, customer_id: UUID, photo_id: UUID
    ) -> bool: ...


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


@dataclass(frozen=True, slots=True)
class FinanceTransactionSummary:
    id: UUID
    organization_id: UUID
    created_by: UUID
    transaction_type: str
    amount: Decimal
    transaction_date: str
    category: str
    counterparty: str
    memo: str
    is_archived: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class FinanceSummary:
    income_total: Decimal
    expense_total: Decimal
    net_total: Decimal
    transaction_count: int


@runtime_checkable
class FinanceRepository(Protocol):
    async def list_transactions(
        self,
        organization_id: UUID,
        from_date: date | None,
        to_date: date | None,
        transaction_type: str | None,
    ) -> list[FinanceTransactionSummary]: ...

    async def create_transaction(
        self, organization_id: UUID, created_by: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary: ...

    async def update_transaction(
        self, organization_id: UUID, transaction_id: UUID, values: dict[str, object]
    ) -> FinanceTransactionSummary | None: ...

    async def summarize_transactions(
        self, organization_id: UUID, from_date: date | None, to_date: date | None
    ) -> FinanceSummary: ...


@dataclass(frozen=True, slots=True)
class FileSummary:
    id: UUID
    organization_id: UUID
    uploaded_by: UUID
    original_name: str
    content_type: str
    size_bytes: int
    is_archived: bool
    created_at: str
    updated_at: str
    storage_path: str


@runtime_checkable
class FileRepository(Protocol):
    async def list_files(
        self, organization_id: UUID, include_archived: bool = False
    ) -> list[FileSummary]: ...

    async def create_file(
        self,
        organization_id: UUID,
        uploaded_by: UUID,
        values: dict[str, object],
    ) -> FileSummary: ...

    async def get_file(self, organization_id: UUID, file_id: UUID) -> FileSummary | None: ...

    async def archive_file(self, organization_id: UUID, file_id: UUID) -> FileSummary | None: ...


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
