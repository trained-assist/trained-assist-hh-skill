# Strict credential storage for the replacement target

The legacy runtime keeps its established compatibility behavior: without `CRED_ENCRYPTION_KEY`, credential writes remain plaintext with a warning and plaintext files remain readable. Do not enable the strict setting on the retiring GCP runtime as part of the migration.

The replacement HH host must set both:

- `CRED_ENCRYPTION_REQUIRED=true`
- `CRED_ENCRYPTION_KEY` to a 64-character hexadecimal AES-256 key delivered through the host's secret mechanism.

With strict mode enabled, the store fails closed when the key is missing or malformed, refuses plaintext files that should be encrypted, and propagates ciphertext authentication failures even when a `.meta` sidecar is missing. Valid v2 AES-256-GCM files continue to read and write through the existing store API. Bookkeeping files explicitly excluded by `shouldEncrypt()` remain plaintext.

Before enabling the replacement service, verify the restored profile binding privately, confirm raw credential file bytes are encrypted and do not contain the source token, verify readback with the intended key, and verify refusal with a missing or wrong key. Keep the source copy unchanged until the encrypted copy and rollback path are verified. Never put key values, tokens, profile IDs, or vacancy IDs in logs, CI artifacts, or repository files.

This setting is opt-in so existing behavior remains stable while the new host can require encryption from its first write. The repository's credential store is mirrored in the legacy Agent; this target-only mode is intentionally documented as an HH-skill-specific deviation until the legacy mirror is updated through its own reviewed change.
