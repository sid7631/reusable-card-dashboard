"""Response shapes. Cards are flattened so the SPA keeps its existing Card type."""

from typing import Any

from app.models import Asset, AssetVersion


def asset_meta(asset: Asset, version: AssetVersion, access: str | None, owner_name: str | None,
               gov: dict[str, Any] | None = None) -> dict[str, Any]:
    gov = gov or {}
    return {
        "pending_request_id": gov.get("pending_request_id"),
        # Lineage for private copies of global assets:
        # {asset_id, name, base_version_no, global_version_no, base_version, global_version, stale}
        "fork": gov.get("fork"),
        # Global assets: open change requests that would change it — [{id, requested_by_name}]
        "open_requests": gov.get("open_requests", []),
        "id": asset.id,
        "name": version.name,
        "description": version.description,
        "scope": asset.scope,
        "owner_id": asset.owner_id,
        "owner_name": owner_name,
        "access": access,
        "can_edit": access in ("admin", "owner", "edit"),
        "version_id": version.id,
        "version_no": version.version_no,
        # Display version: "3" (global), "3.2" (private copy of global v3), "0.4" (never published)
        "version": version.label,
        "head_version_id": asset.head_version_id,
        "forked_from_asset_id": asset.forked_from_asset_id,
        "created_at": asset.created_at.isoformat(),
        "updated_at": asset.updated_at.isoformat(),
        "deleted_at": asset.archived_at.isoformat() if asset.archived_at else None,
    }


def card_out(asset: Asset, version: AssetVersion, access: str | None, owner_name: str | None,
             gov: dict[str, Any] | None = None) -> dict[str, Any]:
    spec = version.spec
    return {
        **asset_meta(asset, version, access, owner_name, gov),
        "chart_type": spec["chart_type"],
        "dataset": "transactions",
        "data_source_id": spec["data_source"]["asset_id"],
        "data_source_version_id": spec["data_source"]["version_id"],
        "config": spec.get("config", {}),
        "query": spec["query"],
        # Raw SQL cards only; semantic cards compile per request (see /api/semantic/compile)
        "sql_text": spec["query"].get("sql", ""),
        "created_via": spec.get("created_via", "builder"),
    }


def version_out(version: AssetVersion, author_name: str | None) -> dict[str, Any]:
    return {
        "id": version.id,
        "version_no": version.version_no,
        "version": version.label,
        "name": version.name,
        "change_note": version.change_note,
        "created_by": version.created_by,
        "created_by_name": author_name,
        "created_at": version.created_at.isoformat(),
    }
