import json
from uuid import UUID

import httpx
import pytest
from business_assistant_desktop.api_client import ApiClient, Customer, CustomerPhoto
from business_assistant_desktop.session import Session

ORG = UUID("11111111-1111-1111-1111-111111111111")
CUSTOMER = UUID("22222222-2222-2222-2222-222222222222")
ACTIVITY = UUID("33333333-3333-3333-3333-333333333333")
SESSION = Session("token", None, CUSTOMER)
PROFILE: dict[str, object] = {
    "name": "고객",
    "email": None,
    "phone": "01012345678",
    "notes": "상담",
    "tags": ["VIP", "신규"],
    "status": "active",
    "birth_date": "1990-01-02",
    "skin_type": "dry",
    "concerns": ["건조", "민감"],
    "allergies": "",
    "last_visit_date": "2026-09-01",
    "next_visit_date": "2026-09-20",
}
ACTIVITY_PAYLOAD: dict[str, object] = {
    "id": str(ACTIVITY),
    "organization_id": str(ORG),
    "customer_id": str(CUSTOMER),
    "activity_type": "consultation",
    "title": "상담",
    "description": "피부 상담",
    "occurred_at": "2026-09-17T09:00:00Z",
}
PHOTO_ID = UUID("44444444-4444-4444-4444-444444444444")
PHOTO_PAYLOAD: dict[str, object] = {
    "id": str(PHOTO_ID),
    "organization_id": str(ORG),
    "customer_id": str(CUSTOMER),
    "storage_path": f"{ORG}/{CUSTOMER}/{PHOTO_ID}.jpg",
    "content_type": "image/jpeg",
    "size_bytes": 2048,
    "caption": "정면",
    "created_at": "2026-09-29T09:00:00Z",
}


def test_customer_defaults_allow_minimal_construction() -> None:
    customer = Customer(CUSTOMER, "고객")
    assert (customer.email, customer.phone, customer.notes) == (None, None, "")


def test_create_customer_record_sends_entire_profile_in_one_request() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.method == "POST"
        assert request.url.path == f"/api/v1/organizations/{ORG}/customers"
        assert request.headers["Authorization"] == "Bearer token"
        assert json.loads(request.content) == PROFILE
        return httpx.Response(201, json={"id": str(CUSTOMER), **PROFILE})

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    customer = api.create_customer_record(ORG, SESSION, PROFILE)
    assert len(requests) == 1
    assert customer.id == CUSTOMER
    assert customer.tags == ("VIP", "신규")
    assert customer.concerns == ("건조", "민감")
    assert customer.allergies == ""
    assert customer.birth_date == "1990-01-02"
    assert customer.next_visit_date == "2026-09-20"


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_customer_activity_routes_and_parsing(method: str) -> None:
    values: dict[str, object] = {
        "activity_type": "consultation",
        "title": "상담",
        "description": "피부 상담",
    }

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == method
        assert request.url.path == f"/api/v1/organizations/{ORG}/customers/{CUSTOMER}/activities"
        assert request.headers["Authorization"] == "Bearer token"
        if method == "POST":
            assert json.loads(request.content) == values
        return httpx.Response(200, json=[ACTIVITY_PAYLOAD] if method == "GET" else ACTIVITY_PAYLOAD)

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    activity = (
        api.list_customer_activities(ORG, SESSION, CUSTOMER)[0]
        if method == "GET"
        else api.create_customer_activity(ORG, SESSION, CUSTOMER, values)
    )
    assert activity.id == ACTIVITY
    assert activity.customer_id == CUSTOMER
    assert activity.activity_type == "consultation"
    assert activity.title == "상담"
    assert activity.description == "피부 상담"
    assert activity.occurred_at == "2026-09-17T09:00:00Z"


@pytest.mark.parametrize(
    "operation", ["create_customer_record", "list_customer_activities", "create_customer_activity"]
)
def test_customer_methods_raise_for_http_errors(operation: str) -> None:
    api = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(403, json={"detail": "Forbidden"})
            )
        ),
    )
    args = (
        (ORG, SESSION, PROFILE)
        if operation == "create_customer_record"
        else (
            (ORG, SESSION, CUSTOMER)
            if operation == "list_customer_activities"
            else (ORG, SESSION, CUSTOMER, {})
        )
    )
    with pytest.raises(httpx.HTTPStatusError):
        getattr(api, operation)(*args)


@pytest.mark.parametrize(
    "field", ["id", "customer_id", "activity_type", "title", "description", "occurred_at"]
)
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_customer_activity_rejects_malformed_fields(field: str, method: str) -> None:
    payload = {**ACTIVITY_PAYLOAD, field: 123}
    api = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json=[payload] if method == "GET" else payload)
            )
        ),
    )
    with pytest.raises(ValueError, match=field):
        if method == "GET":
            api.list_customer_activities(ORG, SESSION, CUSTOMER)
        else:
            api.create_customer_activity(ORG, SESSION, CUSTOMER, {})


@pytest.mark.parametrize("payload", [{}, None, [None]])
def test_customer_activity_list_rejects_invalid_shape(payload: object) -> None:
    api = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
        ),
    )
    with pytest.raises(ValueError):
        api.list_customer_activities(ORG, SESSION, CUSTOMER)


def test_create_customer_record_rejects_malformed_response() -> None:
    api = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(201, json={"id": str(CUSTOMER), "name": 123})
            )
        ),
    )
    with pytest.raises(ValueError, match="name"):
        api.create_customer_record(ORG, SESSION, PROFILE)


def test_customer_photo_upload_registers_and_puts_bytes() -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST" and request.url.path.endswith("/photos/upload-url"):
            return httpx.Response(
                201, json={"photo": PHOTO_PAYLOAD, "signed_url": "https://upload.test/signed"}
            )
        if request.method == "PUT":
            assert request.url == "https://upload.test/signed"
            assert request.content == b"jpeg-bytes"
            return httpx.Response(200)
        raise AssertionError(request)

    api = ApiClient("https://api.test", httpx.Client(transport=httpx.MockTransport(respond)))
    photo = api.upload_customer_photo(
        ORG, SESSION, CUSTOMER, "face.jpg", b"jpeg-bytes", "image/jpeg"
    )
    assert isinstance(photo, CustomerPhoto)
    assert photo.id == PHOTO_ID
    assert requests[0].method == "POST"
    assert json.loads(requests[0].content) == {
        "original_name": "face.jpg",
        "content_type": "image/jpeg",
        "size_bytes": 10,
        "caption": "",
    }


def test_customer_photo_list_parses_payload() -> None:
    api = ApiClient(
        "https://api.test",
        httpx.Client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[PHOTO_PAYLOAD]))
        ),
    )
    photos = api.list_customer_photos(ORG, SESSION, CUSTOMER)
    assert photos == [
        CustomerPhoto(
            PHOTO_ID,
            CUSTOMER,
            PHOTO_PAYLOAD["storage_path"],
            "image/jpeg",
            2048,
            "정면",
            PHOTO_PAYLOAD["created_at"],
        )
    ]
