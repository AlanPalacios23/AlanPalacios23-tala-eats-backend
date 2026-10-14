from pathlib import Path

def test_catalog_media_contract_is_declared():
    from app import models, schemas
    assert hasattr(models.Restaurant, "cover_image_url")
    assert hasattr(models.MenuItem, "image_url")
    assert "cover_image_url" in schemas.RestaurantPublic.model_fields
    assert "image_url" in schemas.MenuItemPublic.model_fields

def test_catalog_media_migration_exists():
    path = Path(__file__).parents[1] / "migrations" / "versions" / "f19g00000001_catalog_media.py"
    assert path.is_file()
