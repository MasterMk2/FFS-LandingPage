import pytest
from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


@pytest.mark.parametrize(
    "path", ["/", "/status", "/leaderboard", "/tracks", "/privacy", "/guide", "/skyrunner"]
)
def test_pages_link_the_site_icons(path):
    response = client.get(path)

    assert response.status_code == 200
    assert 'rel="icon"' in response.text
    assert "/static/favicon.ico?v=" in response.text
    assert "/static/icon-192.png?v=" in response.text
    assert 'rel="apple-touch-icon"' in response.text


@pytest.mark.parametrize(
    ("path", "content_type", "magic"),
    [
        ("/favicon.ico", "image/x-icon", b"\x00\x00\x01\x00"),
        ("/static/favicon.ico", None, b"\x00\x00\x01\x00"),
        ("/apple-touch-icon.png", "image/png", b"\x89PNG"),
        ("/static/apple-touch-icon.png", "image/png", b"\x89PNG"),
        ("/static/icon-192.png", "image/png", b"\x89PNG"),
    ],
)
def test_icon_files_are_served(path, content_type, magic):
    response = client.get(path)

    assert response.status_code == 200
    if content_type:
        assert response.headers["content-type"] == content_type
    assert response.content.startswith(magic)


def test_root_icons_are_cacheable():
    for path in ("/favicon.ico", "/apple-touch-icon.png"):
        assert "max-age" in client.get(path).headers["cache-control"]
