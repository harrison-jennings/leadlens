# Security policy

## Supported versions

Security fixes are made in the latest build. Install the newest release to receive them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could achieve. You'll get an acknowledgement as soon as possible, and updates as the report is investigated and fixed.

## Scope

Leadlens previews and lints email HTML that is often written by someone else. These are treated as security issues:

- an email running script, or reaching the network without the user enabling remote images, in the preview;
- the preview reading local files outside the permitted workspace folders;
- workspace code running in an untrusted workspace;
- Leadlens changing a user's files without an explicit quick fix.

See [Privacy and security](docs/privacy-and-security.md) for the protections Leadlens is designed to provide.

Problems in `@emailens/engine` itself should also be reported to that project.
