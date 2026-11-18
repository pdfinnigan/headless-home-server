# Operating the server

## Deploy

Merge to your branch, then any of:

- `scripts/deploy.sh` from your laptop (runs on the server over SSH)
- `ssh homeserver 'touch /usr/local/var/home-server/request'`, or a service that touches that file
  as the service user (for example, an MCP tool your agent can call)

deploy.sh pulls, redeploys only services whose folder or config entry changed, removes services
that left the config, updates the tunnel routes, and redeploys the gateway Worker when `gateway/`
or the namespaces changed. The result goes to
`/usr/local/var/home-server/status.txt`, with the last ten deploys (`~/.home-server/deploy/history.log`
keeps fifty, one `<started> <ok|failed> <commit>` line each). `scripts/deploy.sh status` shows what's deployed and
whether each service answers. `--force` redeploys everything.

## When a deploy needs you

- `scripts/home-server-helper` changed: run `sudo scripts/install-helper.sh` once (review the change
  and update `scripts/home-server-helper.sha256` in the same commit).
- A new public hostname: `scripts/setup-tunnel.sh` once to add its DNS record. (New MCP
  namespaces need nothing: they share the gateway's hostnames.)
- A new MCP namespace: add it as a connector in each app that should have it.
- A removed public hostname: delete its DNS record in the Cloudflare dashboard.
- A service with a `source` in a private repo: give the admin account read access once. Make a key
  on the server (`ssh-keygen -t ed25519 -f ~/.ssh/<repo>_deploy -N ''`), add the `.pub` as a
  read-only deploy key on that repo, and point an SSH host alias at it in `~/.ssh/config`:

  ```
  Host github-<repo>
    HostName github.com
    IdentityFile ~/.ssh/<repo>_deploy
    IdentitiesOnly yes
  ```

  Then use `git@github-<repo>:<owner>/<repo>.git` as `source.repo`. deploy.sh fetches only the
  pinned commit, into `~/.home-server/deploy/sources/`.

## macOS updates

`ssh <alias> 'sudo -n /usr/local/sbin/home-server-helper os-update check'` lists pending updates.
Without `check` it installs them in the background and restarts the Mac if one needs it, so every
service is down for 20 to 30 minutes. Warn the person before running it. Log:
`/var/log/home-server-os-update.log`.

## Health

`scripts/doctor.sh` checks sleep, firewall, SSH, the helper, open ports, and every service locally
and through its public hostname. For MCP namespaces it also checks that the gateway asks for
sign-in, that the origin refuses requests without Access, and the gateway's own end-to-end probe.
It exits with the number of failures.

`https://<gateway.hostname>/stats` shows each namespace's state and 24-hour uptime from a probe
every 5 minutes; `/usage` (GitHub sign-in) shows calls and errors per app and tool.

## Logs

Every log is in `/usr/local/var/log/home-server/`, and the admin account reads them without sudo.
Each belongs to the user that writes it (group admin, mode 640), so no service can read another's.

- Services: `tail -f /usr/local/var/log/home-server/<service>.log`
- Scheduled jobs: `tail -f /usr/local/var/log/home-server/<service>.<job>.log`. Run one now
  with `sudo launchctl kickstart system/local.home-server.<service>.<job>`.
- Tunnel: `cloudflared.log`; the deploy watcher: `deploy.log` (plus `~/.home-server/deploy/last-run.log`)
- Gateway: Cloudflare dashboard > Workers > the gateway > Observability

Rotation and errors: `local.home-server.logs` runs `home-server-helper logs` as root every 15 min.
A log over 1 MB is copied to `<name>.log.1.gz` (5 kept) and emptied in place, and the job writes
`summary.txt`: each log's size, launchd's restart count and last exit code, and its error lines
from the last 24 h, redacted (no emails, IPs, tokens or long ids).

## Reaching it

`ssh homeserver` (from `scripts/install-ssh-alias.sh`). Off your home network, use Tailscale or a
remote agent session running on the server itself.
