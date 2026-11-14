# Security defaults

Everything here is on after `scripts/harden.sh` and `scripts/install-helper.sh`, and
`scripts/doctor.sh` checks all of it.

## The rules

1. **No open ports on your router.** Public traffic comes in through an outbound Cloudflare Tunnel;
   private traffic through Tailscale. The router's firewall stays closed.
2. **Services listen on 127.0.0.1 only.** Every service gets `HOST=127.0.0.1`. The tunnel and
   Tailscale reach it locally; nothing on your Wi-Fi can.
3. **Each service runs as its own hidden non-admin user** (`<serviceUser>_<name>`) with no
   password and no login shell, its own home, `secrets/` and `data/`. A bug in one service can't
   touch your account, the system, or another service's files. (`"user": "shared"` runs a service
   as the tunnel's user instead, for services that need to share files. Switching a service
   between the two doesn't move its `secrets/` or `data/`: copy them over yourself. Removing a
   service keeps its user and files, so adding it back finds them; delete the user with
   `sudo sysadminctl -deleteUser <user>` to remove it for good.) Only `"user": "shared"` services
   can request a deploy (the request file belongs to the shared user).
4. **Firewall on, stealth mode on.** The Mac doesn't answer probes on closed ports.
5. **SSH accepts keys only**, and root can't log in. harden.sh refuses to switch password login off
   until your admin account has a key, so it can't lock you out.
6. **One narrow passwordless sudo rule.** It covers `/usr/local/sbin/home-server-helper` and nothing
   else. The helper can only create hidden non-admin service users, install staged files into a
   service user's home and start them as that user, so it gives your admin account no new root powers. `/usr/local/sbin` is root-owned so
   nothing running as you can replace the helper, and install-helper.sh only installs a helper
   whose hash matches `scripts/home-server-helper.sha256`.
7. **Access-protected services are enforced at the tunnel.** With `auth: access`, the ingress rule
   itself requires a valid Access token, so requests that didn't pass your policy never reach the
   service, even if someone finds the hostname. `auth: gateway` services sit behind an Access app
   that only the gateway's service token passes.
8. **MCP namespaces are separate.** Each one is its own OAuth resource with its own allowed apps
   and tool allowlist, checked at the gateway on every call (docs/gateway.md).

## Secrets

Secrets never go in the config, the repo, or a chat. Put them where only that service's user can
read them, from Terminal on the server, after its first deploy (which creates the user and an
empty `secrets/`). For a service named `my-service` and the default `serviceUser` `svc`:

```
sudo -u svc_my_service sh -c 'umask 077; cat > ~/secrets/my-service.env'
# paste KEY=value lines, then Ctrl-D
```

A service reads `$HOME/secrets/<name>.env` at startup. Tunnel credentials live the same way in
`~svc/.cloudflared/`; the gateway's secrets live in Cloudflare (scripts/gateway-secrets.sh).

## Things to watch

- Screen Sharing and other sharing services listen on your network. Turn off what you don't use.
- Dev tools (code-server, Jupyter, etc.) often bind to 0.0.0.0 by default. `doctor.sh` lists every
  port that isn't on 127.0.0.1.
- A deploy runs whatever is on your branch. Protect the branch, or keep the repo to yourself.
