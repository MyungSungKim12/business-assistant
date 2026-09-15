from typing import Annotated, Literal
from uuid import UUID

from business_assistant_common.auth import AuthSession, AuthSignUpResult, AuthUser
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from business_assistant_server.dependencies.auth import (
    AuthAdapter,
    AuthenticationConfigurationError,
    AuthenticationError,
    get_auth_adapter,
    get_current_user,
)

router = APIRouter()


class SignUpRequest(BaseModel):
    email: str
    password: str
    display_name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    user_id: UUID
    email: str
    display_name: str | None


class SessionResponse(BaseModel):
    access_token: str
    refresh_token: str | None
    user: UserResponse


class SignUpSessionResponse(SessionResponse):
    email_confirmation_required: Literal[False] = False


class EmailConfirmationRequiredResponse(BaseModel):
    email_confirmation_required: Literal[True] = True


def _session_response(session: AuthSession) -> SessionResponse:
    user = session.user
    return SessionResponse(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        user=UserResponse(user_id=user.user_id, email=user.email, display_name=user.display_name),
    )


def _sign_up_response(
    result: AuthSignUpResult,
) -> SignUpSessionResponse | EmailConfirmationRequiredResponse:
    if result.email_confirmation_required:
        return EmailConfirmationRequiredResponse()
    if result.session is None:
        raise AuthenticationError()
    session_response = _session_response(result.session)
    return SignUpSessionResponse(**session_response.model_dump())


def _authentication_http_error(error: Exception) -> HTTPException:
    if isinstance(error, AuthenticationConfigurationError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication unavailable",
        )
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")


@router.post(
    "/auth/signup",
    response_model=SignUpSessionResponse | EmailConfirmationRequiredResponse,
)
async def sign_up(
    request: SignUpRequest, auth_adapter: Annotated[AuthAdapter, Depends(get_auth_adapter)]
) -> SignUpSessionResponse | EmailConfirmationRequiredResponse:
    try:
        return _sign_up_response(await auth_adapter.sign_up(**request.model_dump()))
    except (AuthenticationError, AuthenticationConfigurationError) as error:
        raise _authentication_http_error(error) from None


@router.post("/auth/login", response_model=SessionResponse)
async def login(
    request: LoginRequest, auth_adapter: Annotated[AuthAdapter, Depends(get_auth_adapter)]
) -> SessionResponse:
    try:
        return _session_response(await auth_adapter.sign_in(**request.model_dump()))
    except (AuthenticationError, AuthenticationConfigurationError) as error:
        raise _authentication_http_error(error) from None


@router.post("/auth/refresh", response_model=SessionResponse)
async def refresh(
    request: RefreshRequest, auth_adapter: Annotated[AuthAdapter, Depends(get_auth_adapter)]
) -> SessionResponse:
    try:
        return _session_response(await auth_adapter.refresh(request.refresh_token))
    except (AuthenticationError, AuthenticationConfigurationError) as error:
        raise _authentication_http_error(error) from None


@router.get("/me", response_model=UserResponse)
async def me(current_user: Annotated[AuthUser, Depends(get_current_user)]) -> UserResponse:
    return UserResponse(
        user_id=current_user.user_id,
        email=current_user.email,
        display_name=current_user.display_name,
    )
