# Security policy

Security fixes target the latest commit on the default branch. Update your checkout, install dependencies with `npm ci`, and rebuild before reporting a problem.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/MajesteitBart/linearcli/security/advisories/new). Include the affected commit, operating system, Node.js version, steps to reproduce and expected impact. Remove tokens and personal workspace data from examples.

Keep vulnerability details out of public issues until maintainers have assessed the report and coordinated disclosure with you.

## Credential storage

OAuth credentials are stored locally as plaintext. Unix permissions or Windows ACLs restrict access. Keep the configuration directory out of Git, shared folders and public backups. Environment-provided credentials are not saved by the CLI.
