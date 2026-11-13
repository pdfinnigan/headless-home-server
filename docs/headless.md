# Running headless

The goal is a machine you never have to open: no screen, no keyboard, lid closed or open on a shelf.

## What `scripts/harden.sh` sets

| Setting | Why |
| --- | --- |
| `pmset sleep 0`, `disksleep 0`, `disablesleep 1` | The machine stays awake, lid closed included. The display may still sleep. |
| `pmset womp 1` | Wakes for network access. |
| `pmset autorestart 1` | Restarts after a power cut. Most laptops don't support it; a laptop's battery covers short outages anyway. |
| Security responses and data files install automatically | Small, safe, usually no restart. |
| macOS upgrades don't install automatically | A surprise restart can take the server down (see FileVault below). Your agent installs them when you say so. |

## Reboots and FileVault

After a reboot, services only come back if the Mac gets past the startup screen.

| Option | After a reboot |
| --- | --- |
| FileVault on | Waits for the password at the machine. Nothing runs until then. |
| FileVault off | Comes back by itself. Anyone holding the machine can read its disk. |

`harden.sh` never changes FileVault. `doctor.sh` tells you which you have. If the server holds
nothing private, turning FileVault off is usually worth it. If it does, keep it on and accept a
trip to the machine after a reboot.

## Services are LaunchDaemons

Every service and the tunnel run as LaunchDaemons under the service user. They start at boot,
before anyone logs in, and restart if they exit. Logs are in the service user's
`~/Library/Logs/<service>.log`.

## Laptops as servers

- A battery that's always charging ages and can swell. Newer macOS limits charge on its own
  ("Optimized Battery Charging"); check battery health now and then.
- Give it airflow. Lid open with the screen off runs cooler than closed.

## Reaching it when SSH doesn't work

Screen Sharing (System Settings > General > Sharing) from another Mac on the same network. Or run a
remote agent session on the server itself, so your agent can reach it with your laptop closed.
