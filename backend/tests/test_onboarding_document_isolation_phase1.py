"""Prevent cross-tenant private identity-file attachment and download.

All tests use isolated SQLite, disposable local files, and synthetic accounts.
"""
import json

from fastapi.testclient import TestClient
from sqlalchemy import select

from app import models
from app.config import settings
from app.db import SessionLocal
from app.main import app


def _new_user(client, key):
    res = client.post("/api/v1/auth/register", json={
        "name": f"QA {key}",
        "email": f"phase1-doc-{key}@example.test",
        "password": "QA-documents-test-Strong1!",
    })
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}, res.json()["user"]["id"]


def _upload(client, auth):
    res = client.post(
        "/api/v1/uploads/onboarding-document",
        headers=auth,
        files={"file": ("identity.pdf", b"%PDF-1.7\nsynthetic-no-identity-data\n%%EOF", "application/pdf")},
    )
    assert res.status_code == 200, res.text
    return res.json()["url"]


def _onboard(client, auth, docs):
    return client.post("/api/v1/operations/onboarding", headers=auth, json={
        "entity_type": "restaurant",
        "business_name": "QA demo",
        "documents": docs,
    })


def test_private_document_requires_original_uploader_and_exact_db_reference(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    with TestClient(app) as client:
        owner, owner_id = _new_user(client, "owner")
        other, other_id = _new_user(client, "other")
        url = _upload(client, owner)
        assert url.startswith(f"/api/v1/uploads/onboarding-document/u{owner_id}-")
        assert client.get(url, headers=owner).status_code == 403  # Not yet associated.
        assert _onboard(client, other, [url]).status_code == 403
        assert _onboard(client, owner, [url]).status_code == 201
        assert client.get(url, headers=owner).status_code == 200
        assert client.get(url, headers=other).status_code == 403

        # Legacy DB manipulation cannot launder another tenant's file.
        with SessionLocal() as db:
            record = db.scalar(select(models.OnboardingApplication).where(
                models.OnboardingApplication.user_id == other_id))
            if record is None:
                record = models.OnboardingApplication(
                    user_id=other_id, entity_type="restaurant", business_name="QA",
                    documents_json=json.dumps([url]),
                )
                db.add(record)
            else:
                record.documents_json = json.dumps([url])
            db.commit()
        assert client.get(url, headers=other).status_code == 403


def test_document_assignment_rejects_forged_missing_duplicate_and_substring(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    with TestClient(app) as client:
        auth, uid = _new_user(client, "duplicates")
        good = _upload(client, auth)
        assert _onboard(client, auth, [good, good]).status_code == 400
        assert _onboard(client, auth, [good + "x"]).status_code == 403
        assert _onboard(client, auth, [good.replace(f"u{uid}-", "u9999-")]).status_code == 403
        assert _onboard(client, auth, [f"/api/v1/uploads/onboarding-document/u{uid}-{'A'*32}.pdf"]).status_code == 400
        assert _onboard(client, auth, [good]).status_code == 201


def test_uploaded_identity_document_enforces_magic_and_ownership(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "media_dir", tmp_path)
    with TestClient(app) as client:
        auth, _ = _new_user(client, "magic")
        bad = client.post(
            "/api/v1/uploads/onboarding-document", headers=auth,
            files={"file": ("not-a-pdf.pdf", b"not really a pdf", "application/pdf")},
        )
        assert bad.status_code == 415
        assert list((tmp_path / "onboarding").glob("*")) == []
