# Setup Guide: Router Mode with Shared VLAN

This guide walks you through connecting everything and setting up R&J PisoWifi in "External Router" mode, using your real setup: a laptop running 2 virtual machines, a MikroTik hEX E50UG router, and a TP-Link EAP225 access point.

This is written in plain, simple language. Take it one step at a time. Don't skip ahead.

---

## 1. What you'll need

- Your laptop, with 2 VMs already set up (one for WiFi rental, one for PC rental)
- MikroTik hEX E50UG router (5 ports)
- TP-Link EAP225 access point
- Your internet modem
- The switch for your PC rental computers
- Enough network cables for everything below

---

## 2. The plan (read this first)

Here is what plugs into which port, and why:

- **Port 1** → your internet modem (this is the WAN port)
- **Port 2** → your laptop's cable. This one cable carries **two** things at once:
  - Normal traffic for your **PC rental** VM
  - Specially tagged (VLAN 13) traffic for your **WiFi rental** VM
- **Port 3** → the switch with your PC rental computers
- **Port 4** → your home WiFi router/AP
- **Port 5** → your TP-Link EAP225 (the WiFi rental customer AP)

The trick: your laptop only needs **one cable**, because the WiFi rental VM tags its own traffic with the number 13. Your EAP225 AP stays completely simple, it never touches any VLAN setting, it just joins the tagged group from the other side.

---

## 3. Step 1: Cable everything up

1. Modem → **Port 1**
2. Laptop's network cable → **Port 2**
3. PC rental switch → **Port 3**
4. Home router/AP → **Port 4**
5. TP-Link EAP225 → **Port 5**

---

## 4. Step 2: Tag your WiFi rental VM's traffic

This step happens **inside your app's own Network page**, no terminal, no typing commands.

1. Log into the admin panel **on your WiFi rental VM**.
2. Click **Network** in the left sidebar.
3. Scroll down to the **VLAN Management** card.
4. Click **Create VLAN**.
5. Fill in:
   - **Base Interface**: pick your VM's real network card from the list
   - **VLAN ID**: `13`
   - **VLAN Mode**: `LAN - Customer Network`
   - **Protocol**: `DHCP (Auto IP from ISP)`
6. Click **Create VLAN**.

That's it. Saving takes effect right away. Your WiFi rental VM now tags its own traffic with VLAN 13 automatically, every time, with no extra steps needed later.

---

## 5. Step 3: Turn on External Router mode

Now switch to the admin panel that will actually talk to your MikroTik. This can be run from either VM, whichever one you want managing the router.

1. Go to **Network**.
2. Under **Network Mode**, pick **External Router**.
3. Read the yellow warning box. It explains: works with RouterOS 6 or 7, your router's Hotspot and DHCP need to be set up first, and customers will always land on your portal, never on MikroTik's own screen.
4. Fill in the **Connection** fields:
   - **MikroTik IP Address**: your router's IP
   - **MikroTik Username**: your router's admin username
   - **MikroTik Password**: your router's admin password
   - **Hotspot Interface**: you can leave this at its default. It isn't actually used anymore by the newer port setup below, so don't worry about getting it exactly right.
   - **Use encrypted connection**: check this box only if your router has `api-ssl` turned on. If you're not sure, leave it unchecked for now.
5. If you see a **Server's Network Connection** dropdown appear, that means this machine has more than one network connection. Pick the one that's actually plugged into your gated (paid) lane, like WiFi rental.
6. Click **Test Connection**. It should say success before you continue.
7. Click **Save Network Settings**.

---

## 6. Step 4: Set your internet plan speed

1. Still on the Network page, find **Your Internet Plan**.
2. Enter your real total Mbps from your ISP, for example `400`.
3. Click **Save**.

Every speed warning later is based on this number, so make sure it's accurate.

---

## 7. Step 5: Set up Ports and Roles

Scroll to **Ports and Roles**. You'll see a card for each of your router's 5 physical ports. Here's exactly what to enter for each one.

**Port 1 (ether1):**
- Role: **WAN**

**Port 2 (ether2) — your laptop's cable, has two lanes:**
- Its **untagged lane**: Role **Open**, name it `PC rental`, speed `100` Mbps
- Click **Add VLAN lane**, type `13`
- On that new VLAN 13 lane: Role **Gated**, name it `WiFi rental`, speed `100` Mbps, burst `20` Mbps

**Port 3 (ether3) — the PC rental switch:**
- Its untagged lane: Role **Open**
- Click **Combine with another lane**, pick **PC rental** (Port 2's untagged lane)

**Port 4 (ether4) — home AP:**
- Role: **Open**, name it `Home`, speed `100` Mbps

**Port 5 (ether5) — the TP-Link EAP225:**
- Do **not** click "Add VLAN lane" on this port. Leave it on its plain untagged lane.
- Role: **Gated**
- Click **Combine with another lane**, pick **WiFi rental** (Port 2's VLAN 13 lane)

Check the running total at the bottom doesn't go over your internet plan number from Step 4.

Click **Save Port Roles**.

---

## 8. Step 6: Set up your EAP225's WiFi networks (SSIDs)

Your EAP225 needs to broadcast two separate WiFi networks:

**1. Your customer portal WiFi** (combining 2.4GHz and 5GHz under one name is fine, this is a normal AP setting and has nothing to do with the VLAN setup above):
- Give it whatever name you want customers to see
- Do **not** put any VLAN tag on this SSID. Leave it untagged/native. This matters, keep reading below.

**2. Your coin-slot (ESP32) WiFi:**
- 2.4GHz only. The ESP32 hardware physically cannot connect to 5GHz networks, so this one has to be 2.4GHz.
- Give it a password so random phones don't join it by accident.
- Do **not** put any VLAN tag on this SSID either, same reason as below.

**Important: don't try to VLAN-tag either SSID on the EAP225 itself.** We already found out the hard way (see `bugslog.md` Bug #78) that this specific AP model can't reliably tag its own WiFi traffic, even when its own settings page shows it as configured. That's exactly why the whole VLAN 13 trick in this guide has your **laptop** doing the tagging instead of the AP. Keep both SSIDs on this AP plain and untagged, and let the router sort out where their traffic goes.

---

## 9. Step 7: Preview, then Configure

1. Click **Preview Changes**.
2. Read through the list of commands. It's okay if some of it looks technical, just check that the port numbers and names look right.
3. If it looks correct, click **Configure**.
4. The app automatically backs up your router's current settings first, before changing anything.
5. Watch the log. It should end with everything marked as successful. If something fails partway, it stops right there and tells you exactly which step failed, nothing is left half-done.

---

## 10. Step 8: Connect your ESP32 and trust it

1. Power on your coin-slot ESP32 and let it join the 2.4GHz SSID you made in Step 6.
2. In the admin panel, go to **Devices**. Once the ESP32 has connected and registered itself, it will show up in the **Connected Devices** table with its MAC address.
3. Copy that MAC address.
4. Scroll down to the **Trusted Devices** card.
5. Click **Add Trusted Device**, paste in the MAC address, and give it a label like "Coin slot ESP32".

This gives the ESP32 internet access at all times, coins or no coins, without it ever needing to go through your customer login page. This setting survives reboots too, you only need to do it once.

---

## 11. Step 9: Test everything

Go through each of these one at a time:

1. **Home AP (Port 4)**: connect a phone, you should get internet right away, no login screen.
2. **PC rental computers (Port 3)**: should work exactly like before.
3. **WiFi rental AP (Port 5)**: connect a phone to that WiFi, it should take you straight to your coin-op portal page.
4. **ESP32 coin slot**: check the Devices page shows it Online, and the dashboard's Coin Slot status shows Online too.
5. **Admin dashboard**: check that the AP shows Online.
6. Insert a coin (or run a test session) and confirm the internet actually turns on for that device.

---

## 12. If something looks wrong

- Don't guess and keep pushing forward. Stop and check.
- Tell me exactly what you see on screen: which port, which step, what error message.
- `bugslog.md` in this project has a full history of bugs found and fixed, in case something looks familiar.

---

## 13. One honest note before you start

Everything in this guide has been carefully built and tested, but only against a simulated router here in development, never a real MikroTik. This will be the very first time any of it touches real hardware. That's exactly why Step 6 has you Preview before you Configure, take a moment to actually read that list before clicking the final button.
