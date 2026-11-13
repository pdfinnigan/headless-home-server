# Operating the server

## Deploy

Merge to your branch, then any of:

- `scripts/deploy.sh` from your laptop (runs on the server over SSH)
- `ssh homeserver 'touch /usr/local/var/home-server/request'`, or a service that touches that file
  as the service user (for example, an MCP tool your agent can call)

deploy.sh pulls, redeploys only services whose folder or config entry changed, removes services
that left the config, and updates the tunnel routes. The result goes to
`/usr/local/var/home-server/status.txt`. `scripts/deploy.sh status` shows what's deployed and
whether each service answers. `--force` redeploys everything.

## When a deploy needs you

- `scripts/home-server-helper` changed: run `sudo scripts/install-helper.sh` once (review the change
  and update `scripts/home-server-helper.sha256` in the same commit).
- A new public hostname: `scripts/setup-tunnel.sh` once to add its DNS record.

## Health

`scripts/doctor.sh` checks sleep, firewall, SSH, the helper, open ports, and every service locally
and through its public hostname. It exits with the number of failures.

## Logs

- Services and tunnel: `sudo tail -f ~svc/Library/Logs/<service>.log` (or `cloudflared.log`)
- Deploys: `~/.home-server/deploy/last-run.log` and `~/Library/Logs/home-server-deploy.log`

## Reaching it

`ssh homeserver` (from `scripts/install-ssh-alias.sh`). Off your home network, use Tailscale or a
remote agent session running on the server itself.
