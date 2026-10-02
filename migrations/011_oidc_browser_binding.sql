-- Pending pre-upgrade login attempts cannot be redeemed without a browser binding.
ALTER TABLE oidc_login_attempts ADD COLUMN browser_binding_hash text;
