# On-call runbook

Credentials used by the deploy job. The values below are the examples the providers publish in their own
documentation, so none of them opens anything.

## Cloud account

The deploy role uses the access key `AKIAIOSFODNN7EXAMPLE` with the secret from the vault.

## Signing

The service signs sessions as JWTs, for example:

eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c

The old host key was pasted here by mistake and has since been rotated:

-----BEGIN RSA PRIVATE KEY-----
RkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRQ==
-----END RSA PRIVATE KEY-----

Nothing else on this page is sensitive.
