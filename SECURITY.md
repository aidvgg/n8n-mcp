# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/aidvgg/n8n-mcp/security/advisories/new) for this repository. Do not open a public issue for a suspected vulnerability.

## Scope note

This server holds an n8n API key and proxies full control over an n8n instance, including `delete_workflow` and `execute_workflow`. Anyone who can reach the HTTP transport can run every tool.

## HTTP transport authentication

Since 1.6.0 the HTTP transport requires a bearer token.

- Set `MCP_AUTH_TOKEN` to a secret of at least 32 characters. Generate one with `openssl rand -hex 32`.
- Every `/mcp` and `/docs` request must send `Authorization: Bearer <token>`. Missing or wrong tokens get 401.
- If `MCP_AUTH_TOKEN` is unset or too short, `/mcp` and `/docs` return 503. There is no way to opt out of authentication.
- `/health` stays open and returns only status, mode, version and uptime.
- Tokens are compared with `crypto.timingSafeEqual` over SHA-256 digests, so the check is constant time and leaks no length.
- stdio mode runs as a local child process of the client and needs no token.

Rotate `MCP_AUTH_TOKEN` and the n8n API key together if either may have been exposed. Keep a reverse proxy, network allow-list or VPN in front of a public deployment as well; the bearer token is the floor, not the whole perimeter.
