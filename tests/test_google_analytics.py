import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app


client = TestClient(app)
GA_ID = "G-TEST123456"
GTAG_SRC = f"https://www.googletagmanager.com/gtag/js?id={GA_ID}"


@pytest.fixture
def ga_enabled(monkeypatch):
    monkeypatch.setitem(main.templates.env.globals, "ga_measurement_id", GA_ID)


def test_no_tag_when_measurement_id_is_unset():
    response = client.get("/?lang=en")

    assert response.status_code == 200
    assert "googletagmanager.com" not in response.text


@pytest.mark.parametrize("path", ["/", "/status", "/leaderboard", "/tracks", "/privacy"])
def test_every_page_loads_gtag_when_measurement_id_is_set(ga_enabled, path):
    response = client.get(path)

    assert response.status_code == 200
    assert GTAG_SRC in response.text
    assert f"gtag('config', '{GA_ID}');" in response.text


@pytest.mark.parametrize("path", ["/panel/servers", "/panel/sysmon"])
def test_htmx_polling_panels_do_not_send_page_views(ga_enabled, path):
    response = client.get(path)

    assert response.status_code == 200
    assert "googletagmanager.com" not in response.text


@pytest.mark.parametrize(
    "raw", ["", "   ", "UA-12345678-1", "G-test123456", "G-TEST');alert(1);//"]
)
def test_malformed_measurement_id_disables_the_tag(raw):
    assert main._ga_measurement_id(raw) is None


def test_measurement_id_from_env_file_is_trimmed():
    assert main._ga_measurement_id(" G-TEST123456\n") == "G-TEST123456"


def test_privacy_page_discloses_google_analytics_and_opt_out():
    en = client.get("/privacy?lang=en")
    ja = client.get("/privacy?lang=ja")

    assert en.status_code == 200 and ja.status_code == 200
    assert "Google Analytics" in en.text
    assert "Google アナリティクス" in ja.text
    for page in (en, ja):
        assert "policies.google.com/technologies/partner-sites" in page.text
        assert "tools.google.com/dlpage/gaoptout" in page.text


def test_footer_links_to_privacy_policy():
    assert 'href="/privacy">プライバシーポリシー</a>' in client.get("/?lang=ja").text
    assert 'href="/privacy">Privacy Policy</a>' in client.get("/?lang=en").text
