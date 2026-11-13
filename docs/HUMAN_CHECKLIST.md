# What only you can do

Your agent does everything else. These are the steps that need a person: a sign-in, a secret,
or the admin password. Each one is a single action, and none of them needs you to sit at the server
after step 1.

1. **At the server, once:** sign in to your admin account, turn on Remote Login (System Settings >
   General > Sharing), and note its IP address (System Settings > Network). On your router, give
   that address a DHCP reservation so it never changes.
2. **Your laptop's SSH key:** from your laptop, `ssh-copy-id you@<server-ip>`. This is the last time
   the server accepts a password over SSH.
3. **A private copy of this repo:** on GitHub, "Use this template" > Private. Your config goes in it,
   and it holds your domain and LAN address, so keep it private.
4. **The read-only deploy key:** `scripts/setup-server.sh` prints a key and a link. Paste the key
   there and leave "Allow write access" unticked.
5. **One sudo paste** (your agent gives you the exact line): `scripts/harden.sh` then
   `scripts/install-helper.sh`. After this, routine deploys never ask for a password.
6. **If anything is public:** a domain on Cloudflare (free plan is fine). `scripts/setup-tunnel.sh`
   prints a sign-in URL; open it on any device and pick the domain. It asks for your password once
   to hand the tunnel's credentials to the service user.
7. **For each service with `auth: access`:** create a self-hosted Access application for its
   hostname in the Cloudflare Zero Trust dashboard, with a policy (for example, your email), and
   give your agent its Audience (AUD) tag. That tag is an identifier, not a secret.
8. **Secrets a service needs** (API keys, passwords): put them in the service user's files
   yourself, from Terminal, never in chat or in the repo. See docs/security.md, "Secrets".
