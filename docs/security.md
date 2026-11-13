# Security defaults

Everything here is on after `scripts/harden.sh` and `scripts/install-helper.sh`, and
`scripts/doctor.sh` checks all of it.

## The rules

1. **No open ports on your router.** Public traffic comes in through an outbound Cloudflare Tunnel;
   private traffic through Tailscale. The router's firewall stays closed.
2. **Services listen on 127.0.0.1 only.** Every service gets `HOST=127.0.0.1`. The tunnel and
   Tailscale reach it locally; nothing on your Wi-Fi can.
3. **Services run as a hidden non-admin user** with no password and no login shell. A bug in a
   service can't touch your account or the system.
4. **Firewall on, stealth mode on.** The Mac doesn't answer probes on closed ports.
5. **SSH accepts keys only**, and root can't log in. harden.sh refuses to switch password login off
   until your admin account has a key, so it can't lock you out.
6. **One narrow passwordless sudo rule.** It covers `/usr/local/sbin/home-server-helper` and nothing
   else. The helper can only install staged files into the service user's home and start them as
   that user, so it gives your admin account no new root powers. `/usr/local/sbin` is root-owned so
   nothing running as you can replace the helper, and install-helper.sh only installs a helper
   whose hash matches `scripts/home-server-helper.sha256`.
7. **Access-protected services are enforced at the tunnel.** With `auth: access`, the ingress rule
   itself requires a valid Access token, so requests that didn't pass your policy never reach the
   service, even if someone finds the hostname.

## Secrets

Secrets never go in the config, the repo, or a chat. Put them where only the service user can read
them, from Terminal on the server:

```
sudo -u svc mkdir -p ~svc/secrets && sudo -u svc chmod 700 ~svc/secrets
sudo -u svc sh -c 'cat > ~svc/secrets/my-service.env' && sudo -u svc chmod 600 ~svc/secrets/my-service.env
# paste KEY=value lines, then Ctrl-D
```

A service reads `$HOME/secrets/<name>.env` at startup. Tunnel credentials already live this way in
`~svc/.cloudflared/`.

## Things to watch

- Screen Sharing and other sharing services listen on your network. Turn off what you don't use.
- Dev tools (code-server, Jupyter, etc.) often bind to 0.0.0.0 by default. `doctor.sh` lists every
  port that isn't on 127.0.0.1.
- A deploy runs whatever is on your branch. Protect the branch, or keep the repo to yourself.
