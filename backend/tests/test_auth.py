from cryptography.hazmat.primitives.asymmetric import rsa

from tests.conftest import make_token


async def test_missing_token_is_401(client):
    assert (await client.get("/api/me")).status_code == 401


async def test_bad_signature_is_401(client):
    forged = make_token("mallory", role="admin", key=rsa.generate_private_key(public_exponent=65537, key_size=2048))
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {forged}"})).status_code == 401


async def test_expired_token_is_401(client):
    token = make_token("late", exp_in=-10)
    assert (await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})).status_code == 401


async def test_first_request_provisions_user_with_role_from_token(admin):
    me = (await admin.get("/api/me")).json()
    assert me["sub"] == admin.sub and me["role"] == "admin"
