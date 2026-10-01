from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_hermes_application_page_is_public_and_links_to_privacy_policy():
    response = client.get("/hermes?lang=en")

    assert response.status_code == 200
    assert "Hermes Personal Assistant" in response.text
    assert "Google Calendar" in response.text
    assert "subscribed calendar list" in response.text
    assert "Gmail" in response.text
    assert "Discord" in response.text
    assert "LINE" in response.text
    assert "AI model service" in response.text
    assert 'href="/hermes/privacy"' in response.text
    assert 'name="robots" content="noindex, nofollow, noarchive"' in response.text


def test_hermes_privacy_page_covers_google_user_data_obligations():
    response = client.get("/hermes/privacy?lang=en")

    assert response.status_code == 200
    for required_text in (
        "Information collected",
        "Purpose of use",
        "Storage and protection",
        "External processing and delivery",
        "subscribed Google Calendar list",
        "Discord",
        "LINE",
        "AI model service",
        "Retention and deletion",
        "Google API Services User Data Policy",
        "Limited Use requirements",
    ):
        assert required_text in response.text
    assert 'href="/hermes"' in response.text


def test_hermes_pages_render_in_japanese():
    application = client.get("/hermes?lang=ja")
    privacy = client.get("/hermes/privacy?lang=ja")

    assert "アプリの機能" in application.text
    assert "Google ユーザーデータの利用" in application.text
    assert "取得する情報" in privacy.text
    assert "購読している Google Calendar の一覧" in privacy.text
    assert "外部での処理と配信" in privacy.text
    assert "保持と削除" in privacy.text


def test_global_footer_links_to_stable_hermes_urls():
    response = client.get("/?lang=en")

    assert response.status_code == 200
    assert 'href="/hermes"' in response.text
    assert 'href="/hermes/privacy"' in response.text
