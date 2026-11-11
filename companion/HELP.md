## Ubiquiti UniFi Network

Controls Ubiquiti UniFi Network devices via the **official, local Integration API** (API key, no session
cookies) instead of the old private controller API. The connection therefore also works with 2FA protected
accounts, and the documented API is expected to stay more stable across firmware updates than the private one.

### Configuration

- **Host / IP** — IP address or hostname of the UniFi console (UDM, UDM Pro, UDR, Cloud Key, ...).
- **Port** — usually 443 on UniFi OS consoles.
- **Verify TLS certificate** — off by default, because UniFi consoles use a self-signed certificate. Only enable it
  if the console uses a certificate this machine trusts.
- **API Key** — created on the console itself under _Settings → Control Plane → Integrations_.
- **Site ID / Site** — usually `default`. Before the first successful connection this is a free text field;
  once the module knows the sites of the console it automatically becomes a dropdown of the real sites. With
  only one site it stays a text field, because the connection always uses that single site anyway.
- **Poll interval** — how often device/port state is refreshed for feedbacks and variables (0 = off).
- **Enable persistent PoE on/off** — enables the legacy action (see below). Off by default.
- **Legacy username/password** — only relevant if the option above is enabled. Must be a **local** admin account
  on the console, **without** 2FA and **without** Ubiquiti cloud SSO — both break this login method.

### Actions

- **Restart device** — official API.
- **Switchport: PoE power cycle** — briefly switches a port off and on again (official API). This is the only port
  action the official API offers. Select the port with the **Switch** and **Port** dropdowns; the port dropdown
  only shows the ports that actually exist on the selected switch.
- **Switchport: Set PoE on/off (legacy)** — only works if enabled in the configuration (while disabled, the action is
  shown as _disabled in config_ and only logs a hint, so existing buttons are kept). Switches PoE on a port
  on or off permanently, using the same switch/port selection as above. The official API offers **no** write
  access for this (neither directly nor via port profiles), so this action has to use the old private controller
  API and may break without notice after firmware updates.
- **Refresh device list** — immediately reloads devices/ports and all dropdown lists/presets (e.g. after adding a
  new switch).

### Feedbacks

- **Device online** — active while the selected device is online.
- **Switchport: PoE delivering power** — active while the selected port is currently delivering PoE power.
- **Network client online** — active while the selected client (computer, phone, AV device, ...) is connected to
  the network. The list only shows clients the module has seen at least once (searchable for many entries).

### Variables

**Connection:** `connection_status`, `application_version`, `site_id`, `device_count`, `device_count_online`,
`last_poll_time`, `last_action_result`

**Per device** (generated automatically for every device found, the name becomes a slug, e.g.
`FOH-SW-Audio` → `foh_sw_audio`):

- `device_<slug>_online` — `Online`/`Offline`
- `device_<slug>_client_count` — access points only: number of clients currently connected to it

**Per PoE port** (only ports with PoE capability):

- `port_<slug>_<portidx>_link` — link state, `up`/`down`
- `port_<slug>_<portidx>_poe` — port is currently delivering PoE power, `up`/`down`
- `port_<slug>_<portidx>_poe_enabled` — PoE administratively enabled, `ON`/`OFF`

**Per network client** (every device UniFi has seen connected — computers, phones, AV devices, ..., not just
UniFi hardware; keyed by MAC address):

- `client_<mac>_online` — `Online`/`Offline`. The UniFi API has no explicit "offline" state for clients (a
  disconnected client simply disappears from the list), so the module remembers every client seen during the
  connection and derives "offline" from it missing in the current response. Newly connected clients appear as a
  variable after the next poll cycle.

These variables are rebuilt whenever the device list changes (e.g. after "Refresh device list") or a previously
unknown client connects, and are updated with current values on every poll cycle.

### Presets

Besides the restart and PoE power cycle buttons there is a **Warnings** category with a ready-made button per
device that turns red and shows "⚠ <device> OFFLINE" as soon as that device is no longer online (based on the
inverted "Device online" feedback, no action). Useful for the core switch or other devices whose failure is
critical.

### Upgrading from module version 2.x

Version 3.0 replaces the old username/password login (node-unifi) with the official Integration API.

- **An API key is required.** After the upgrade, create an API key on the console and enter it in the connection
  settings. Host, port and site are taken over.
- The old username and password are moved to the legacy fields. If the old **Switchport: Set POE mode** action was
  in use, "persistent PoE on/off" is enabled automatically, so those buttons keep working. If the migrated buttons
  show the action as _disabled in config_, enable "persistent PoE on/off" and enter the local admin account.
- **Switchport: Power Cycle** becomes **Switchport: PoE power cycle**, **Switchport: Set POE mode** becomes
  **Switchport: Set PoE on/off (legacy)**. Migrated actions still reference the switch by MAC address, which is
  resolved to the device automatically; re-selecting the switch in the dropdown is optional. The mode
  _24V passive_ is migrated to _PoE on_ (auto) — the module never switches a port to passive PoE.
- The "SSL Verify" setting is taken over as **Verify TLS certificate**.
- Old actions whose switch MAC address or port number was an **expression** are not migrated (the new switch
  field cannot be an expression) and have to be recreated. A mode expression is converted (on unless it
  evaluates to `off`).
- **Profile: Set POE Mode** has no replacement, because the Integration API offers no write access to port
  profiles. These actions remain unknown and have to be replaced manually.
