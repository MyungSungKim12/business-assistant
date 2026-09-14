import uvicorn

from business_assistant_server.main import create_app


def main() -> None:
    uvicorn.run(create_app(), host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
