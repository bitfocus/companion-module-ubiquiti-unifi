## Ubiquiti UniFi

This module will allow you to control the POE mode of ubiquiti UniFi switches.

### Configuration

- Enter the IP Address of the UniFi controller.
- Enter the port of the UniFi controller.
- Enter a local user on the UniFi controller. NOTE: It is recommended to make a unique user just for this application.
- Enter the password for the user. NOTE: This password will be stored in clear text within the companion config.

### Connection

The module checks the controller every 10 seconds and reconnects automatically if the connection drops or the login session expires, so there is no need to restart the connection. If a button is pressed while disconnected, the module reconnects first and then runs the action.

Use a local UniFi account without two-factor authentication: the 2FA code is single-use, so automatic reconnection cannot work with 2FA enabled.

### To use the module

Add an action to a button and choose the action you wish to use.
NOTE: Commands may not be executed immediately if a large number of update actions are stacked.

**Available actions:**

- Power Cycle POE Switchport
- Switchport POE Mode
- Profile POE Mode

**Variables:**

- `$(unifi:connection_status)` – `ok`, `connecting` or `failed`
- `$(unifi:last_error)` – why the last connection attempt failed
- `$(unifi:last_connected)` – time the connection was last established
- `$(unifi:reconnect_count)` – automatic reconnections since the connection was configured
- `$(unifi:last_action)` – the last action run, e.g. `Power cycle port aa:bb:cc:dd:ee:ff@4`
- `$(unifi:last_action_result)` – `ok`, or `failed: <reason>`
- `$(unifi:last_action_time)` – time the last action finished

Replace `unifi` with your connection's label if you renamed it.

**Feedbacks:**

- Controller: connection state – style a button when the controller is connected, connecting or failed (default: red when failed)
- Last action failed – style a button when the most recent action did not succeed
